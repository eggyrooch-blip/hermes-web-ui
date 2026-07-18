import type { Server, Socket } from 'socket.io'
import { addMessage, clearSessionMessages, createSession, getSession, renameSession, updateSessionStats } from '../../../db/hermes/session-store'
import { config } from '../../../config'
import { logger } from '../../logger'
import type { AgentBridgeClient } from '../agent-bridge'
import { flushBridgePendingToDb } from './bridge-message'
import { buildDbHistory, estimateSnapshotAwareHistoryUsage, forceCompressBridgeHistory, getOrCreateSession, replaceState } from './compression'
import { handleAbort } from './abort'
import { calcAndUpdateUsage, contextTokensWithCachedOverhead, updateMessageContextTokenUsage } from './usage'
import { contentBlocksToString } from './content-blocks'
import {
  createSessionCommandFence,
  enqueueSerializedSessionCommand,
  reserveQueuedSessionCommand,
} from './session-command-queue'
import { captureSessionRunOwnership, ownsSessionGeneration } from './session-run-ownership'
import { recordPendingResumeEvent } from './pending-resume-events'
import type {
  ContentBlock,
  QueuedRun,
  SessionCommandReservation,
  SessionState,
} from './types'

type CommandName =
  | 'usage'
  | 'status'
  | 'abort'
  | 'queue'
  | 'skill'
  | 'plan'
  | 'goal'
  | 'subgoal'
  | 'clear'
  | 'title'
  | 'compress'
  | 'steer'
  | 'destroy'
  | 'reload-mcp'

interface ParsedSessionCommand {
  name: CommandName
  rawName: string
  args: string
}

interface SessionCommandContext {
  nsp: ReturnType<Server['of']>
  socket: Socket
  sessionMap: Map<string, SessionState>
  bridge: AgentBridgeClient
  profile: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  instructions?: string
  queueId?: string
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void
  dequeueNextQueuedRun?: (socket: Socket, sessionId: string, fallbackProfile?: string) => boolean
  commandReservation?: SessionCommandReservation
}

const COMMAND_ALIASES: Record<string, CommandName> = {
  usage: 'usage',
  status: 'status',
  abort: 'abort',
  queue: 'queue',
  skill: 'skill',
  plan: 'plan',
  goal: 'goal',
  subgoal: 'subgoal',
  clear: 'clear',
  title: 'title',
  compress: 'compress',
  steer: 'steer',
  destroy: 'destroy',
  'reload-mcp': 'reload-mcp',
}

export function parseSessionCommand(input: string | ContentBlock[]): ParsedSessionCommand | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = COMMAND_ALIASES[rawName]
  if (!name) return { name: 'status', rawName, args: match[2]?.trim() || '' }
  return { name, rawName, args: match[2]?.trim() || '' }
}

export function isSessionCommand(input: string | ContentBlock[]): boolean {
  return parseSessionCommand(input) !== null
}

function isSerializedSessionCommand(
  command: ParsedSessionCommand,
): command is ParsedSessionCommand & { name: 'plan' | 'goal' | 'subgoal' } {
  return command.name === 'plan' || command.name === 'goal' || command.name === 'subgoal'
}

export async function handleSessionCommand(
  sessionId: string,
  command: ParsedSessionCommand,
  ctx: SessionCommandContext,
): Promise<void> {
  try {
    await handleSessionCommandImpl(sessionId, command, ctx)
  } catch (err) {
    if (!ctx.commandReservation) throw err
    failReservedSessionCommand(sessionId, command, ctx, err)
  }
}

async function handleSessionCommandImpl(
  sessionId: string,
  command: ParsedSessionCommand,
  ctx: SessionCommandContext,
): Promise<void> {
  let state = getOrCreateSession(ctx.sessionMap, sessionId)
  ctx.socket.join(`session:${sessionId}`)
  ensureCommandSession(sessionId, ctx)
  if (isSerializedSessionCommand(command) && !ctx.commandReservation) {
    const enqueued = enqueueSerializedSessionCommand({
      sessionId,
      command,
      state,
      sessionMap: ctx.sessionMap,
      queueId: ctx.queueId,
      model: ctx.model,
      provider: ctx.provider,
      modelGroups: ctx.model_groups,
      instructions: ctx.instructions,
      profile: ctx.profile,
      originSocketId: ctx.socket.id,
    })
    state = enqueued.state
    const queued = enqueued.queued
    emitQueuedState(ctx, sessionId, state)
    if (!enqueued.canStart) return

    if (ctx.dequeueNextQueuedRun) {
      ctx.dequeueNextQueuedRun(ctx.socket, sessionId, ctx.profile)
      return
    }

    if (state.queue[0] !== queued) return
    state.queue.shift()
    const reservation = reserveQueuedSessionCommand(sessionId, state, queued)
    if (!reservation) return
    await handleSessionCommand(sessionId, command, { ...ctx, commandReservation: reservation })
    return
  }

  const reservation = ctx.commandReservation
  const commandFence = reservation
    ? createSessionCommandFence(sessionId, state, ctx.sessionMap, reservation)
    : null
  const observationFence = reservation
    ? null
    : createSessionCommandObservationFence(sessionId, state, ctx.sessionMap)
  const ownsCommandGeneration = () => commandFence?.owns() ?? observationFence?.ownsGeneration() ?? false
  const ownsCommandExecution = () => commandFence?.owns() ?? observationFence?.owns() ?? false
  const releaseCommandReservation = () => commandFence?.release() ?? false
  const abandonCommandResult = () => commandFence?.abandon()
  const dequeueAfterCommand = () => {
    if (state.queue.length > 0) ctx.dequeueNextQueuedRun?.(ctx.socket, sessionId, ctx.profile)
  }
  const isKnownCommand = Boolean(COMMAND_ALIASES[command.rawName])
  if (!ownsCommandExecution()) return
  if (command.name !== 'plan' && command.name !== 'skill' && isKnownCommand) {
    persistCommandMessage(sessionId, state, `/${command.rawName}${command.args ? ` ${command.args}` : ''}`, ctx.queueId)
  }

  const emitCommand = (payload: Record<string, unknown>, generationOnly = false) => {
    if (!(generationOnly ? ownsCommandGeneration() : ownsCommandExecution())) return false
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (message) persistCommandMessage(sessionId, state, message)
    emitToSession(ctx.nsp, ctx.socket, sessionId, 'session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: command.rawName,
      ok: true,
      ...payload,
    })
    return true
  }

  if (command.name === 'skill') {
    const displayCommand = `/${command.rawName}${command.args ? ` ${command.args}` : ''}`
    const skillParts = command.args.split(/\s+/, 2)
    const skillName = skillParts[0]?.trim()
    if (!skillName) {
      emitCommand({
        ok: false,
        action: 'skill',
        terminal: !state.isWorking,
        message: 'Usage: /skill <skill-name> [instructions]',
      })
      return
    }
    const rest = command.args.slice(skillName.length).trim()
    const bridgeCommand = `/${skillName}${rest ? ` ${rest}` : ''}`
    let result
    try {
      result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
    } catch (err) {
      if (!ownsCommandExecution()) return
      if (state.isWorking) emitQueuedState(ctx, sessionId, state)
      emitCommand({
        ok: false,
        action: 'skill',
        terminal: !state.isWorking,
        message: `Skill command failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    if (!ownsCommandExecution()) return

    const expandedPrompt = typeof result.message === 'string' ? result.message.trim() : ''
    if (result.handled && expandedPrompt && (result.type === 'skill' || result.type === 'bundle')) {
      logger.info(
        '[chat-run-socket] /skill resolved session=%s profile=%s skill=%s bridge_type=%s',
        sessionId,
        ctx.profile,
        skillName,
        result.type,
      )
      logger.info(
        '[chat-run-socket] /skill expanded prompt session=%s profile=%s skill=%s chars=%d expanded_prompt=%s',
        sessionId,
        ctx.profile,
        skillName,
        expandedPrompt.length,
        expandedPrompt,
      )
      const next: QueuedRun = {
        queue_id: ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: expandedPrompt,
        displayInput: displayCommand,
        displayRole: 'command',
        storageMessage: expandedPrompt,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (state.isWorking) {
        state.queue.push(next)
        emitQueuedState(ctx, sessionId, state)
        return
      }

      if (!emitCommand({
        action: result.type === 'bundle' ? 'bundle' : 'skill',
        terminal: false,
        started: true,
      })) return
      if (!ownsCommandExecution()) return
      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
      return
    }

    logger.warn(
      '[chat-run-socket] /skill unresolved session=%s profile=%s skill=%s bridge_type=%s message=%s',
      sessionId,
      ctx.profile,
      skillName,
      typeof result.type === 'string' ? result.type : '',
      typeof result.message === 'string' ? result.message : '',
    )
    if (state.isWorking) emitQueuedState(ctx, sessionId, state)
    emitCommand({
      ok: false,
      action: 'error',
      terminal: !state.isWorking,
      message: result?.message || `Unknown bridge command: /${command.rawName}`,
    })
    return
  }

  if (!isKnownCommand) {
    if (state.isWorking) emitQueuedState(ctx, sessionId, state)
    emitCommand({
      ok: false,
      action: 'error',
      terminal: !state.isWorking,
      message: `Unknown bridge command: /${command.rawName}`,
    })
    return
  }

  switch (command.name) {
    case 'usage': {
      const usage = await calcAndUpdateUsage(sessionId, state, (event, payload) => {
        if (ownsCommandExecution()) emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
      })
      if (!ownsCommandExecution()) return
      emitCommand({
        action: 'usage',
        terminal: !state.isWorking,
        message: `Usage: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${usage.inputTokens + usage.outputTokens} tokens.`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      return
    }

    case 'status': {
      const row = getSession(sessionId)
      const bridgeStatus = await getBridgeSessionStatus(ctx, sessionId)
      if (!ownsCommandExecution()) return
      const bridgeRunning = bridgeStatus?.running === true
      const isWorking = state.isWorking || bridgeRunning
      const runId = state.runId || state.activeRunMarker || bridgeStatus?.currentRunId || null
      emitCommand({
        action: 'status',
        terminal: !isWorking,
        message: [
          `Status: ${isWorking ? 'running' : 'idle'}`,
          `source: ${state.source || row?.source || 'cli'}`,
          `profile: ${state.profile || ctx.profile || row?.profile || 'default'}`,
          `model: ${ctx.model || row?.model || '-'}`,
          `queue: ${state.queue.length}`,
          `run: ${runId || '-'}`,
          bridgeStatus ? `bridge: ${bridgeRunning ? 'running' : 'idle'}` : null,
        ].filter(Boolean).join(', '),
        isWorking,
        isAborting: Boolean(state.isAborting),
        queueLength: state.queue.length,
        source: state.source || row?.source || 'cli',
        profile: state.profile || ctx.profile || row?.profile || 'default',
        model: ctx.model || row?.model || null,
        runId,
        bridgeStatus,
      })
      return
    }

    case 'abort':
      await handleAbort(
        ctx.nsp,
        ctx.socket,
        sessionId,
        ctx.sessionMap,
        ctx.bridge,
        ctx.runQueuedItem,
        ctx.dequeueNextQueuedRun,
      )
      emitCommand({ action: 'abort', message: 'Abort requested.' })
      return

    case 'queue': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'queue', terminal: !state.isWorking, message: 'Usage: /queue <message>' })
        return
      }
      if (!state.isWorking) {
        emitCommand({ ok: false, action: 'queue', message: 'Session is idle. Send the message normally instead.' })
        return
      }
      const queueId = `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      state.queue.push({
        queue_id: queueId,
        input: command.args,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      })
      emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: state.queue.length,
        queued_messages: serializeVisibleQueuedMessages(state.queue),
      })
      emitCommand({
        action: 'queue',
        terminal: false,
        message: `Queued message. Queue length: ${state.queue.length}.`,
        queueLength: state.queue.length,
      })
      return
    }

    case 'plan': {
      const bridgeCommand = `plan${command.args ? ` ${command.args}` : ''}`
      let result
      try {
        result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
      } catch (err) {
        if (!ownsCommandExecution()) {
          abandonCommandResult()
          return
        }
        emitCommand({
          ok: false,
          action: 'plan',
          terminal: state.queue.length === 0,
          message: `Plan command failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        releaseCommandReservation()
        dequeueAfterCommand()
        return
      }

      if (!ownsCommandExecution()) {
        abandonCommandResult()
        return
      }
      if (!result.handled || !result.message) {
        emitCommand({
          ok: false,
          action: 'plan',
          terminal: state.queue.length === 0,
          message: result.message || 'Plan command is not available.',
        })
        releaseCommandReservation()
        dequeueAfterCommand()
        return
      }

      const queueId = ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const displayCommand = `/${bridgeCommand}`
      const next: QueuedRun = {
        queue_id: queueId,
        input: result.message,
        displayInput: displayCommand,
        displayRole: 'command',
        storageMessage: displayCommand,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (!emitCommand({
        action: 'plan',
        terminal: false,
        started: true,
      })) {
        abandonCommandResult()
        return
      }
      if (!ownsCommandExecution()) {
        abandonCommandResult()
        return
      }
      releaseCommandReservation()
      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
      return
    }

    case 'goal':
    case 'subgoal': {
      const bridgeCommand = `${command.name}${command.args ? ` ${command.args}` : ''}`
      let result
      try {
        result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
      } catch (err) {
        if (!ownsCommandExecution()) {
          abandonCommandResult()
          return
        }
        emitCommand({
          ok: false,
          action: command.name,
          terminal: state.queue.length === 0,
          message: `Goal command failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        releaseCommandReservation()
        dequeueAfterCommand()
        return
      }

      if (!ownsCommandExecution()) {
        abandonCommandResult()
        return
      }
      const kickoffPrompt = typeof result.kickoff_prompt === 'string' ? result.kickoff_prompt.trim() : ''

      const bridgeStatus = result.action === 'goal_status' || result.action === 'status'
        ? await getBridgeSessionStatus(ctx, sessionId)
        : null
      if (!ownsCommandExecution()) {
        abandonCommandResult()
        return
      }
      if (result.clear_goal_continuations) {
        const removed = removeGoalContinuationRuns(state)
        if (removed > 0) emitQueuedState(ctx, sessionId, state)
      }
      const message = formatGoalStatusMessage(String(result.message || ''), bridgeStatus)

      const resultAction = String(result.action || command.name)
      const action = (command.name === 'goal' || command.name === 'subgoal') && resultAction === 'clear'
        ? `${command.name}_clear`
        : resultAction

      if (!emitCommand({
        action,
        terminal: !kickoffPrompt && state.queue.length === 0,
        started: Boolean(kickoffPrompt),
        message,
        type: result.type || 'goal',
        maxTurns: result.max_turns,
        bridgeStatus,
      })) {
        abandonCommandResult()
        return
      }

      if (!kickoffPrompt) {
        releaseCommandReservation()
        dequeueAfterCommand()
        return
      }

      const next: QueuedRun = {
        queue_id: ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: kickoffPrompt,
        displayInput: null,
        storageMessage: kickoffPrompt,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (!ownsCommandExecution()) {
        abandonCommandResult()
        return
      }
      releaseCommandReservation()
      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
      return
    }

    case 'clear': {
      if (command.args === '--history') {
        if (state.isWorking) {
          emitCommand({
            ok: false,
            action: 'clear',
            terminal: false,
            message: 'Cannot clear history while the bridge run is active. Abort or destroy it first.',
          })
          return
        }
        const deleted = clearSessionMessages(sessionId)
        state.messages = []
        clearTransientRunState(state)
        await calcAndUpdateUsage(sessionId, state, (event, payload) => {
          if (ownsCommandExecution()) emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
        })
        if (!ownsCommandExecution()) return
        emitCommand({
          action: 'clear',
          clearHistory: true,
          message: `Cleared ${deleted} history messages from the database.`,
        })
        return
      }
      emitCommand({
        action: 'clear',
        message: 'Cleared the current display. History in the database was not deleted.',
      })
      return
    }

    case 'title': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'title', terminal: !state.isWorking, message: 'Usage: /title <new title>' })
        return
      }
      const title = command.args.slice(0, 120)
      if (!getSession(sessionId)) {
        createSession({ id: sessionId, profile: ctx.profile, source: 'cli', model: ctx.model, title })
      }
      const updated = renameSession(sessionId, title)
      emitCommand({
        ok: updated,
        action: 'title',
        title,
        message: updated ? `Title updated: ${title}` : 'Session was not found in the database.',
      })
      return
    }

    case 'compress': {
      if (state.isWorking) {
        emitCommand({ ok: false, action: 'compress', terminal: false, message: 'Compression can only run while the session is idle.' })
        return
      }
      clearTransientRunState(state)
      const emit = (event: string, payload: any) => {
        if (ownsCommandExecution()) emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
      }
      try {
        const history = await buildDbHistory(sessionId, { excludeLastUser: true })
        if (!ownsCommandExecution()) return
        const usageEstimate = estimateSnapshotAwareHistoryUsage(sessionId, history)
        const beforeContextTokens = contextTokensWithCachedOverhead(state, usageEstimate.tokenCount)
        emit('compression.started', {
          event: 'compression.started',
          message_count: usageEstimate.messageCount,
          token_count: beforeContextTokens,
          source: 'command',
        })
        const result = await forceCompressBridgeHistory(
          sessionId,
          ctx.profile,
          [],
        )
        if (!ownsCommandExecution()) return
        state.bridgeCompressionResults = state.bridgeCompressionResults || {}
        const usage = await calcAndUpdateUsage(sessionId, state, emit)
        if (!ownsCommandExecution()) return
        const afterContextTokens = contextTokensWithCachedOverhead(state, result.afterTokens)
        emit('compression.completed', {
          event: 'compression.completed',
          compressed: result.compressed,
          llmCompressed: result.llmCompressed,
          totalMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: beforeContextTokens,
          afterTokens: result.afterTokens,
          summaryTokens: result.summaryTokens,
          verbatimCount: result.verbatimCount,
          compressedStartIndex: result.compressedStartIndex,
          contextTokens: afterContextTokens,
          source: 'command',
        })
        updateMessageContextTokenUsage(sessionId, state, emit, result.afterTokens, usage)
        emitCommand({
          action: 'compress',
          message: `Compression completed: ${result.beforeMessages} -> ${result.resultMessages} messages, ${beforeContextTokens} -> ${afterContextTokens} tokens.`,
          beforeMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: beforeContextTokens,
          afterTokens: afterContextTokens,
          messageBeforeTokens: result.beforeTokens,
          messageAfterTokens: result.afterTokens,
          compressed: result.compressed,
        })
      } catch (err) {
        if (!ownsCommandExecution()) return
        logger.warn(err, '[chat-run-socket] /compress failed for session %s', sessionId)
        emit('compression.completed', {
          event: 'compression.completed',
          compressed: false,
          totalMessages: 0,
          resultMessages: 0,
          beforeTokens: 0,
          afterTokens: 0,
          error: err instanceof Error ? err.message : String(err),
          source: 'command',
        })
        emitCommand({
          ok: false,
          action: 'compress',
          message: `Compression failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    case 'steer': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'steer', terminal: !state.isWorking, message: 'Usage: /steer <instruction>' })
        return
      }
      if (!state.isWorking) {
        emitCommand({ ok: false, action: 'steer', message: 'No active bridge run to steer.' })
        return
      }
      await ctx.bridge.steer(sessionId, command.args)
      if (!ownsCommandExecution()) return
      emitCommand({ action: 'steer', terminal: false, message: 'Steer instruction sent.' })
      return
    }

    case 'reload-mcp': {
      if (config.webPlane === 'chat') {
        emitCommand({
          ok: false,
          action: 'reload-mcp',
          terminal: !state.isWorking,
          message: 'MCP reload is only available in the admin plane.',
        })
        return
      }
      if (state.isWorking) {
        emitCommand({
          ok: false,
          action: 'reload-mcp',
          terminal: false,
          message: 'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
        })
        return
      }
      try {
        const server = command.args || undefined
        const result = await ctx.bridge.mcpReload(server, ctx.profile)
        if (!ownsCommandExecution()) return
        emitCommand({
          action: 'reload-mcp',
          message: `MCP reloaded successfully.${server ? ` Server: ${server}` : ' All servers.'}`,
          result,
        })
      } catch (err) {
        if (!ownsCommandExecution()) return
        emitCommand({
          ok: false,
          action: 'reload-mcp',
          terminal: !state.isWorking,
          message: `MCP reload failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    case 'destroy': {
      const wasWorking = state.isWorking
      let bridgeReachable = true
      let bridgeError: string | null = null
      let commandStillCurrent = true
      try {
        if (wasWorking) {
          flushBridgePendingToDb(state, sessionId)
          await ctx.bridge.interrupt(sessionId, 'Destroyed by user', state.profile).catch((err) => {
            logger.warn(err, '[chat-run-socket] /destroy interrupt failed for session %s', sessionId)
          })
          commandStillCurrent = ownsCommandExecution()
        }
        if (commandStillCurrent) {
          await ctx.bridge.destroy(sessionId, state.profile).catch((err) => {
            bridgeReachable = false
            bridgeError = err instanceof Error ? err.message : String(err)
            logger.warn(err, '[chat-run-socket] /destroy bridge unavailable for session %s', sessionId)
          })
          commandStillCurrent = ownsCommandExecution()
        }
      } finally {
        if (!commandStillCurrent || !ownsCommandExecution()) return
        updateSessionStats(sessionId)
        await calcAndUpdateUsage(sessionId, state, (event, payload) => {
          if (ownsCommandExecution()) emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
        })
        if (!ownsCommandExecution()) return
        state.isWorking = false
        state.isAborting = false
        state.profile = undefined
        state.abortController = undefined
        state.runId = undefined
        state.responseRun = undefined
        state.activeRunMarker = undefined
        state.events = []
        state.queue = []
        state.bridgePendingAssistantContent = undefined
        state.bridgePendingReasoningContent = undefined
        state.bridgePendingToolCallMarkup = undefined
        state.bridgeOutput = undefined
        state.bridgePendingTools = undefined
        state.bridgeCompressionResults = undefined
        replaceState(ctx.sessionMap, sessionId, 'session.command', {
          event: 'session.command',
          action: 'destroy',
        })
      }
      if (!ownsCommandGeneration()) return
      emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: 0,
      })
      emitCommand({
        action: 'destroy',
        message: bridgeReachable
          ? (wasWorking ? 'Destroyed bridge agent and stopped the active run.' : 'Destroyed bridge agent.')
          : `Bridge agent was not reachable; cleared local session state.${bridgeError ? ` (${bridgeError})` : ''}`,
        destroyed: true,
        bridgeReachable,
      }, true)
      return
    }
  }
}

function createSessionCommandObservationFence(
  sessionId: string,
  state: SessionState,
  sessionMap: Map<string, SessionState>,
) {
  const ownership = captureSessionRunOwnership(
    sessionId,
    state,
    state.activeRunMarker || state.runId || 'idle-command',
  )
  const observed = {
    isWorking: state.isWorking,
    isAborting: Boolean(state.isAborting),
    runId: state.runId,
    activeRunMarker: state.activeRunMarker,
    commandReservationMarker: state.commandReservationMarker,
    abortController: state.abortController,
  }
  const ownsGeneration = () => ownsSessionGeneration(sessionMap, ownership)
  const owns = () => ownsGeneration()
    && state.isWorking === observed.isWorking
    && Boolean(state.isAborting) === observed.isAborting
    && state.runId === observed.runId
    && state.activeRunMarker === observed.activeRunMarker
    && state.commandReservationMarker === observed.commandReservationMarker
    && state.abortController === observed.abortController
  return { owns, ownsGeneration }
}

function failReservedSessionCommand(
  sessionId: string,
  command: ParsedSessionCommand,
  ctx: SessionCommandContext,
  err: unknown,
): void {
  const reservation = ctx.commandReservation
  const state = ctx.sessionMap.get(sessionId)
  if (!reservation || !state) return
  const fence = createSessionCommandFence(sessionId, state, ctx.sessionMap, reservation)
  if (!fence.owns()) {
    fence.abandon()
    return
  }

  const label = command.name === 'plan' ? 'Plan' : command.name === 'subgoal' ? 'Subgoal' : 'Goal'
  const payload: Record<string, unknown> = {
    event: 'session.command',
    session_id: sessionId,
    command: command.rawName,
    ok: false,
    action: command.name,
    terminal: state.queue.length === 0,
    message: `${label} command failed: ${err instanceof Error ? err.message : String(err)}`,
  }
  if (!fence.release()) return
  const resumeEventId = recordPendingResumeEvent(state, 'session.command', payload)
  payload.resume_event_id = resumeEventId
  payload.command_message_id = resumeEventId
  try {
    emitToSession(ctx.nsp, ctx.socket, sessionId, 'session.command', payload)
  } catch (emitErr) {
    logger.warn(emitErr, '[chat-run-socket] reserved command failure room emit failed for session %s', sessionId)
    try {
      if (ctx.socket.connected) ctx.socket.emit('session.command', payload)
    } catch (socketErr) {
      logger.warn(socketErr, '[chat-run-socket] reserved command failure socket emit failed for session %s', sessionId)
    }
  } finally {
    if (state.queue.length > 0) {
      try {
        ctx.dequeueNextQueuedRun?.(ctx.socket, sessionId, ctx.profile)
      } catch (dequeueErr) {
        logger.warn(dequeueErr, '[chat-run-socket] failed to continue queue after command failure for session %s', sessionId)
      }
    }
  }
}

function clearTransientRunState(state: SessionState) {
  state.events = []
  state.bridgePendingTools = undefined
  state.bridgePendingToolCallMarkup = undefined
  state.bridgeCompressionResults = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.runId = undefined
  state.abortController = undefined
  state.isAborting = false
}

function removeGoalContinuationRuns(state: SessionState): number {
  const before = state.queue.length
  state.queue = state.queue.filter(item => !item.goalContinuation)
  return before - state.queue.length
}

function emitQueuedState(ctx: SessionCommandContext, sessionId: string, state: SessionState) {
  emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
    event: 'run.queued',
    session_id: sessionId,
    queue_length: state.queue.length,
    queued_messages: serializeVisibleQueuedMessages(state.queue),
  })
}

function serializeVisibleQueuedMessages(queue: QueuedRun[]) {
  return queue.filter(item => item.displayInput !== null).map(item => ({
    id: item.queue_id,
    role: item.displayRole || (typeof item.displayInput === 'string' && item.displayInput.trim().startsWith('/') ? 'command' : 'user'),
    content: contentBlocksToString(item.displayInput ?? item.input),
    timestamp: Math.floor(Date.now() / 1000),
    queued: true,
  }))
}

type BridgeSessionStatus = {
  exists: boolean
  running: boolean
  currentRunId: string | null
  messageCount: number
}

async function getBridgeSessionStatus(ctx: SessionCommandContext, sessionId: string): Promise<BridgeSessionStatus | null> {
  try {
    const raw = await ctx.bridge.status(sessionId, ctx.profile) as Record<string, unknown>
    return {
      exists: raw.exists === true,
      running: raw.running === true,
      currentRunId: typeof raw.current_run_id === 'string' && raw.current_run_id.trim()
        ? raw.current_run_id
        : null,
      messageCount: typeof raw.message_count === 'number' && Number.isFinite(raw.message_count)
        ? raw.message_count
        : 0,
    }
  } catch (err) {
    logger.debug({ err, sessionId }, '[chat-run-socket] bridge status lookup failed')
    return null
  }
}

function formatGoalStatusMessage(message: string, bridgeStatus: BridgeSessionStatus | null): string {
  if (!bridgeStatus) return message
  const lines = [message]
  if (bridgeStatus.running) {
    const progress = parseGoalTurnProgress(message)
    lines.push(progress
      ? `Current turn: ${Math.min(progress.used + 1, progress.max)}/${progress.max} running (completed turns: ${progress.used}/${progress.max}; count updates after the judge).`
      : 'Current turn: running (turn count updates after the judge).')
  }
  lines.push(`Run: ${bridgeStatus.running ? 'running' : 'idle'}${bridgeStatus.currentRunId ? ` (${bridgeStatus.currentRunId})` : ''}`)
  return lines.filter(Boolean).join('\n')
}

function parseGoalTurnProgress(message: string): { used: number; max: number } | null {
  const match = message.match(/\b(\d+)\s*\/\s*(\d+)\s+turns\b/i)
  if (!match) return null
  const used = Number(match[1])
  const max = Number(match[2])
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return null
  return { used, max }
}

function ensureCommandSession(sessionId: string, ctx: SessionCommandContext) {
  if (getSession(sessionId)) return
  createSession({
    id: sessionId,
    profile: ctx.profile,
    source: 'cli',
    model: ctx.model,
    title: 'Bridge command',
  })
}

function persistCommandMessage(sessionId: string, state: SessionState, content: string, clientId?: string) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    client_id: clientId || null,
    role: 'command',
    content,
    timestamp: now,
  })
  state.messages.push({
    id: clientId || id || `command_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content,
    timestamp: now,
  })
  updateSessionStats(sessionId)
}

function emitToSession(nsp: ReturnType<Server['of']>, socket: Socket, sessionId: string, event: string, payload: any) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}

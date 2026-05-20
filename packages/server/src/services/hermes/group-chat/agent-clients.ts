import { io, Socket } from 'socket.io-client'
import { getToken } from '../../../services/auth'
import type { GatewayManager } from '../gateway-manager'
import { logger } from '../../../services/logger'
import { updateUsage } from '../../../db/hermes/usage-store'
import { config } from '../../../config'
import {
    buildRunBrokerHeaders,
    buildRunBrokerRequest,
    mapRunBrokerFrameForChat,
} from '../run-chat/handle-broker-run'
import {
    isAllAgentsMentioned,
    resolveMentionTargets,
    stripMentionRoutingTokens,
} from './mention-routing'
import { resolveOwnedProfileAgentId } from '../agent-ownership'

// ─── Types ────────────────────────────────────────────────────

interface AgentConfig {
    agentId?: string
    agentSecret?: string
    profile: string
    name: string
    description: string
    invited: number
}

interface MessageData {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
}

interface MentionMessage {
    content: string
    senderName: string
    senderId: string
    timestamp: number
    senderIsAgent?: boolean
}

interface MemberData {
    id: string
    name: string
    joinedAt: number
}

interface JoinResult {
    roomId: string
    roomName: string
    members: MemberData[]
    messages: MessageData[]
    rooms: string[]
}

export interface AgentEventHandler {
    onMessage?: (data: { roomId: string; msg: MessageData }) => void
    onTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onStopTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onMemberJoined?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
    onMemberLeft?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
}

// ─── Agent Client (single connection) ─────────────────────────

class AgentClient {
    readonly agentId: string
    readonly profile: string
    readonly name: string
    readonly description: string
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private gatewayManager: GatewayManager | null = null
    private contextEngine: any = null
    private storage: any = null
    private agentSecret: string | undefined

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}) {
        this.agentId = config.agentId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.profile = config.profile
        this.name = config.name
        this.description = config.description
        this.agentSecret = config.agentSecret
        this.handlers = handlers
    }

    get connected(): boolean {
        return this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.socket?.id
    }

    setGatewayManager(manager: GatewayManager): void {
        this.gatewayManager = manager
    }

    setContextEngine(engine: any): void {
        this.contextEngine = engine
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    async connect(port?: number): Promise<void> {
        const actualPort = port ?? parseInt(process.env.PORT || '8648', 10)
        const token = await getToken()

        this.socket = io(`http://127.0.0.1:${actualPort}/group-chat`, {
            auth: {
                token: token || undefined,
                userId: this.agentId,
                agentId: this.agentId,
                agentSecret: this.agentSecret,
                name: this.name,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
        })

        this.bindEvents()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

            this.socket!.on('connect', () => {
                clearTimeout(timeout)
                logger.debug(`[AgentClient] ${this.name} connected, socket id: ${this.socket!.id}`)
                resolve()
            })

            this.socket!.on('connect_error', (err) => {
                clearTimeout(timeout)
                logger.error(err, `[AgentClient] ${this.name} connect_error`)
                reject(err)
            })
        })
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
            this.joinedRooms.clear()
        }
    }

    async joinRoom(roomId: string): Promise<JoinResult> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('join', { roomId }, (res: JoinResult | { error: string }) => {
                if ('error' in res) {
                    reject(new Error(res.error))
                } else {
                    this.joinedRooms.add(roomId)
                    resolve(res)
                }
            })
        })
    }

    sendMessage(roomId: string, content: string): Promise<string> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('message', { roomId, content }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    reject(new Error(res.error))
                } else {
                    resolve(res.id!)
                }
            })
        })
    }

    startTyping(roomId: string): void {
        this.ensureConnected()
        this.socket!.emit('typing', { roomId })
    }

    stopTyping(roomId: string): void {
        this.ensureConnected()
        this.socket!.emit('stop_typing', { roomId })
    }

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready'): void {
        this.ensureConnected()
        this.socket!.emit('context_status', { roomId, agentName: this.name, status })
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
    }

    private ensureConnected(): void {
        if (!this.socket?.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    // ─── Hermes Gateway Integration ────────────────────────────

    /**
     * Handle an @mention from the server side.
     * Called by AgentClients.processMentions() — no socket round-trip needed.
     * onStatus is called to report context compression progress.
     */
    async replyToMention(
        roomId: string,
        msg: { content: string; senderName: string; senderId: string; timestamp: number },
        onStatus?: (status: 'compressing' | 'replying' | 'ready') => void,
    ): Promise<void> {
        logger.debug(`[AgentClients] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
        if (!this.gatewayManager) {
            logger.debug(`[AgentClients] ${this.name}: gatewayManager is null, skipping`)
            return
        }

        const upstream = this.gatewayManager.getUpstream(this.profile)
        const apiKey = this.gatewayManager.getApiKey(this.profile)
        logger.debug(`[AgentClients] ${this.name}: upstream=${upstream}, profile=${this.profile}`)
        if (!upstream) {
            logger.error(`[AgentClients] ${this.name}: no gateway upstream for profile "${this.profile}"`)
            return
        }

        try {
            // Notify room that agent is typing
            this.startTyping(roomId)

            // Build compressed context if context engine is available
            let conversationHistory: Array<{ role: string; content: string }> = []
            let instructions: string | undefined
            let roomInfo: any

            if (this.storage) {
                try { roomInfo = this.storage.getRoom(roomId) } catch { /* ignore */ }
            }

            if (this.contextEngine && this.storage) {
                try {
                    logger.debug(`[AgentClients] ${this.name}: building context...`)
                    onStatus?.('compressing')
                    // Get room members with descriptions for context
                    const roomMembers: Array<{ userId: string; name: string; description: string }> = this.storage.getRoomMembers(roomId) || []
                    const memberNames = roomMembers.map((m: any) => m.name)
                    const members = roomMembers.map((m: any) => ({ userId: m.userId, name: m.name, description: m.description }))

                    // Get room compression config
                    const compression = roomInfo ? {
                        triggerTokens: roomInfo.triggerTokens,
                        maxHistoryTokens: roomInfo.maxHistoryTokens,
                        tailMessageCount: roomInfo.tailMessageCount,
                    } : undefined

                    const ctx = await this.contextEngine.buildContext({
                        roomId,
                        agentId: this.agentId,
                        agentName: this.name,
                        agentProfile: this.profile,
                        agentDescription: this.description,
                        agentSocketId: this.socket?.id || '',
                        roomName: roomId,
                        memberNames,
                        members,
                        upstream,
                        apiKey,
                        currentMessage: msg,
                        compression,
                        profile: this.profile,
                    })
                    conversationHistory = ctx.conversationHistory
                    instructions = ctx.instructions
                    logger.debug(`[AgentClients] ${this.name}: context built — historyLen=${conversationHistory.length}, meta=%j`, ctx.meta)
                    onStatus?.('replying')
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: context engine failed: ${err.message}`)
                    onStatus?.('replying')
                    // Degrade: continue without context
                }
            }

            // Keep routing explicit while removing only the mention tokens that
            // selected this agent. This avoids making @all look like an
            // instruction for the model to fan out another routing cycle.
            const routedPrefix = isAllAgentsMentioned(msg.content)
                ? `群聊系统：这条消息通过 @all 提及所有 agent，你是其中之一。你当前以 ${this.name}（profile: ${this.profile}）回复，不要声称自己是其它成员或其它 profile。`
                : `群聊系统：这条消息已经提及你（${this.name}）。你当前以 ${this.name}（profile: ${this.profile}）回复；即使消息同时提及其他成员，也不要因此输出空回复。`
            const routedText = stripMentionRoutingTokens(msg.content, this.name) || msg.content
            const input = `${routedPrefix}\n\n原始消息：${routedText}`

            if (config.webuiRunBroker) {
                await this.replyViaRunBroker(roomId, msg, input, conversationHistory, instructions, roomInfo, onStatus)
                return
            }

            const responseRes = await fetch(`${upstream.replace(/\/$/, '')}/v1/responses`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    input,
                    ...(conversationHistory.length > 0 ? { conversation_history: conversationHistory } : {}),
                    ...(instructions ? { instructions } : {}),
                    stream: true,
                    store: false,
                }),
                signal: AbortSignal.timeout(120000),
            })

            if (!responseRes.ok) {
                const text = await responseRes.text().catch(() => '')
                logger.error(`[AgentClients] ${this.name}: gateway response failed (${responseRes.status}): ${text}`)
                this.stopTyping(roomId)
                onStatus?.('ready')
                return
            }

            if (!responseRes.body) {
                logger.error(`[AgentClients] ${this.name}: gateway response stream missing`)
                this.stopTyping(roomId)
                onStatus?.('ready')
                return
            }

            let fullContent = ''
            for await (const frame of readSseFrames(responseRes.body)) {
                let parsed: any
                try {
                    parsed = JSON.parse(frame.data)
                } catch {
                    continue
                }
                const eventType = parsed.type || frame.event || parsed.event
                logger.debug(`[AgentClients] ${this.name}: event=${eventType}`)

                if (eventType === 'response.output_text.delta' && parsed.delta) {
                    fullContent += parsed.delta
                    continue
                }

                if (eventType === 'response.completed') {
                    const response = parsed.response || parsed
                    const finalText = extractResponseText(response)
                    if (!fullContent && finalText) fullContent = finalText
                    const usage = response.usage || {}
                    updateUsage(roomId, {
                        inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
                        outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
                        cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
                        cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
                        reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
                        model: response.model || '',
                        profile: this.profile,
                    })
                    logger.debug(`[AgentClients] ${this.name}: response completed, content length=${fullContent.length}`)
                    if (fullContent) {
                        this.stopTyping(roomId)
                        this.sendMessage(roomId, fullContent)
                    }
                    onStatus?.('ready')
                    return
                }

                if (eventType === 'response.failed') {
                    logger.error(`[AgentClients] ${this.name}: response failed`)
                    this.stopTyping(roomId)
                    onStatus?.('ready')
                    return
                }
            }
            logger.warn(`[AgentClients] ${this.name}: response stream ended without terminal event`)
            this.stopTyping(roomId)
            onStatus?.('ready')
        } catch (err: any) {
            logger.error(`[AgentClients] ${this.name}: error handling message: ${err.message}`)
            this.stopTyping(roomId)
            onStatus?.('ready')
        }
    }

    private async replyViaRunBroker(
        roomId: string,
        msg: { content: string; senderName: string; senderId: string; timestamp: number },
        input: string,
        conversationHistory: Array<{ role: string; content: string }>,
        instructions: string | undefined,
        roomInfo: any,
        onStatus?: (status: 'compressing' | 'replying' | 'ready') => void,
    ): Promise<void> {
        const brokerUrl = config.runBrokerUrl?.replace(/\/$/, '')
        if (!brokerUrl) {
            logger.error(`[AgentClients] ${this.name}: HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1`)
            this.stopTyping(roomId)
            onStatus?.('ready')
            return
        }

        const ownerOpenId = typeof roomInfo?.owner_open_id === 'string' && roomInfo.owner_open_id.trim()
            ? roomInfo.owner_open_id.trim()
            : undefined
        const brokerAgentId = ownerOpenId ? resolveOwnedProfileAgentId(ownerOpenId, this.profile) : undefined
        const sessionId = `group-chat:${roomId}:${this.agentId}`
        const messages = conversationHistory.map((entry, index) => ({
            id: index + 1,
            session_id: sessionId,
            role: entry.role,
            content: entry.content,
            timestamp: Math.floor((msg.timestamp || Date.now()) / 1000) + index,
        }))
        const request = await buildRunBrokerRequest({
            input,
            profile: this.profile,
            ownerOpenId,
            sessionId,
            agentId: brokerAgentId,
            instructions,
            messages: messages as any,
        })
        request.metadata = {
            ...(request.metadata || {}),
            source: 'hermes-web-ui-group-chat',
            room_id: roomId,
            agent_id: this.agentId,
            agent_name: this.name,
        }

        const res = await fetch(`${brokerUrl}/api/run-broker/runs`, {
            method: 'POST',
            headers: buildRunBrokerHeaders({
                runBrokerKey: config.runBrokerKey,
                ownerOpenId,
                agentId: brokerAgentId,
            }),
            body: JSON.stringify(request),
        })

        if (!res.ok) {
            const text = await res.text().catch(() => '')
            logger.error(`[AgentClients] ${this.name}: run broker response failed (${res.status}): ${text}`)
            this.stopTyping(roomId)
            onStatus?.('ready')
            return
        }

        if (!res.body) {
            logger.error(`[AgentClients] ${this.name}: run broker response stream missing`)
            this.stopTyping(roomId)
            onStatus?.('ready')
            return
        }

        let fullContent = ''
        for await (const frame of readSseFrames(res.body)) {
            let parsed: any
            try {
                parsed = JSON.parse(frame.data)
            } catch {
                continue
            }

            const mapped = mapRunBrokerFrameForChat(parsed, frame.event)
            if (mapped.type === 'ignore') continue

            if (mapped.type === 'emit' && mapped.appendFinalText) {
                fullContent += mapped.payload.delta || ''
                continue
            }

            if (mapped.type === 'terminal') {
                if (mapped.event === 'run.failed') {
                    logger.error(`[AgentClients] ${this.name}: run broker response failed`)
                    this.stopTyping(roomId)
                    onStatus?.('ready')
                    return
                }

                const finalText = fullContent || mapped.payload.output || ''
                const usage = mapped.payload.usage || {}
                updateUsage(roomId, {
                    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
                    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
                    cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
                    cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
                    reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
                    model: usage.model || '',
                    profile: this.profile,
                })
                if (finalText) {
                    this.stopTyping(roomId)
                    this.sendMessage(roomId, finalText)
                }
                onStatus?.('ready')
                return
            }
        }

        logger.warn(`[AgentClients] ${this.name}: run broker stream ended without terminal event`)
        this.stopTyping(roomId)
        onStatus?.('ready')
    }

    private bindEvents(): void {
        const s = this.socket!

        s.on('typing', (data: any) => {
            this.handlers.onTyping?.(data)
        })

        s.on('stop_typing', (data: any) => {
            this.handlers.onStopTyping?.(data)
        })

        s.on('member_joined', (data: any) => {
            this.handlers.onMemberJoined?.(data)
        })

        s.on('member_left', (data: any) => {
            this.handlers.onMemberLeft?.(data)
        })

        // Auto rejoin rooms on reconnect
        s.io.on('reconnect', async () => {
            if (this._reconnecting) return
            this._reconnecting = true
            logger.info(`[AgentClients] ${this.name} reconnecting, rejoining ${this.joinedRooms.size} rooms...`)
            const rooms = Array.from(this.joinedRooms)
            for (const roomId of rooms) {
                try {
                    await this.joinRoom(roomId)
                } catch (err: any) {
                    logger.error(`[AgentClients] ${this.name} failed to rejoin room ${roomId}: ${err.message}`)
                }
            }
            this._reconnecting = false
        })
    }
}

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let buffer = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
                const raw = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const frame = parseSseFrame(raw)
                if (frame?.data) yield frame
                boundary = buffer.indexOf('\n\n')
            }
        }

        buffer += decoder.decode()
        const frame = parseSseFrame(buffer)
        if (frame?.data) yield frame
    } finally {
        reader.releaseLock()
    }
}

function parseSseFrame(raw: string): { event?: string; data: string } | null {
    let event: string | undefined
    const data: string[] = []
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
            event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart())
        }
    }
    if (data.length === 0) return null
    return { event, data: data.join('\n') }
}

function extractResponseText(response: any): string {
    const output = Array.isArray(response?.output) ? response.output : []
    const parts: string[] = []
    for (const item of output) {
        if (item.type !== 'message') continue
        const content = Array.isArray(item.content) ? item.content : []
        for (const part of content) {
            if (part.type === 'output_text' || part.type === 'text') {
                parts.push(part.text || '')
            }
        }
    }
    if (parts.length > 0) return parts.join('')
    return typeof response?.output_text === 'string' ? response.output_text : ''
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── AgentClients (roomId -> agents) ──────────────────────────

export class AgentClients {
    private rooms = new Map<string, Map<string, AgentClient>>()
    private _gatewayManager: GatewayManager | null = null
    private _contextEngine: any = null
    private _storage: any = null
    private _agentAuthSecret: string | undefined

    // Per-room processing lock + mention queue
    private _processingRooms = new Set<string>()
    private _mentionQueue = new Map<string, Array<{ agent: AgentClient; msg: MentionMessage }>>()

    setAgentAuthSecret(secret: string): void {
        this._agentAuthSecret = secret
    }

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient({ ...config, agentSecret: this._agentAuthSecret }, handlers)
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._gatewayManager) client.setGatewayManager(this._gatewayManager)
        if (this._contextEngine) client.setContextEngine(this._contextEngine)
        if (this._storage) client.setStorage(this._storage)

        logger.info(`[AgentClients] Connected: ${client.name} (${client.agentId})`)
        return client
    }

    /**
     * Connect an agent to a room.
     */
    async addAgentToRoom(roomId: string, client: AgentClient): Promise<JoinResult> {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }

        room.set(client.agentId, client)
        const result = await client.joinRoom(roomId)
        logger.info(`[AgentClients] ${client.name} joined room: ${roomId}`)
        return result
    }

    /**
     * Remove an agent from a room and disconnect it.
     */
    removeAgentFromRoom(roomId: string, agentId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        const client = room.get(agentId)
        if (client) {
            client.disconnect()
            room.delete(agentId)
            logger.info(`[AgentClients] ${client.name} left room: ${roomId}`)

            // Invalidate context engine cache for this agent
            if (this._contextEngine) {
                try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
            }
        }

        if (room.size === 0) {
            this.rooms.delete(roomId)
        }
    }

    /**
     * Get all agents in a room.
     */
    getAgents(roomId: string): AgentClient[] {
        const room = this.rooms.get(roomId)
        return room ? Array.from(room.values()) : []
    }

    /**
     * Get a specific agent in a room.
     */
    getAgent(roomId: string, agentId: string): AgentClient | undefined {
        return this.rooms.get(roomId)?.get(agentId)
    }

    /**
     * Get all room IDs that have agents.
     */
    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    /**
     * Send a message from a specific agent in a room.
     */
    async sendMessage(roomId: string, agentId: string, content: string): Promise<string> {
        const client = this.getAgent(roomId, agentId)
        if (!client) {
            throw new Error(`Agent "${agentId}" not found in room "${roomId}"`)
        }
        return client.sendMessage(roomId, content)
    }

    /**
     * Broadcast a message from all agents in a room.
     */
    async broadcastFromRoom(roomId: string, content: string): Promise<string[]> {
        const agents = this.getAgents(roomId)
        return Promise.all(agents.map((agent) => agent.sendMessage(roomId, content)))
    }

    /**
     * Disconnect all agents in a room.
     */
    disconnectRoom(roomId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        room.forEach((client) => client.disconnect())
        this.rooms.delete(roomId)
        logger.info(`[AgentClients] All agents disconnected from room: ${roomId}`)

        // Invalidate context engine cache for this room
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
    }

    resetRoomContext(roomId: string): void {
        for (const key of this._mentionQueue.keys()) {
            if (key === roomId || key.startsWith(`${roomId}:`)) this._mentionQueue.delete(key)
        }
        for (const key of Array.from(this._processingRooms)) {
            if (key === roomId || key.startsWith(`${roomId}:`)) this._processingRooms.delete(key)
        }
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
    }

    /**
     * Disconnect all agents in all rooms.
     */
    disconnectAll(): void {
        this.rooms.forEach((room) => {
            room.forEach((client) => client.disconnect())
        })
        this.rooms.clear()
        logger.info('[AgentClients] All agents disconnected')
    }

    /**
     * Set gateway manager for all existing and future agents.
     */
    setGatewayManager(manager: GatewayManager): void {
        this._gatewayManager = manager
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setGatewayManager(manager))
        })
    }

    /**
     * Set context engine for all existing and future agents.
     */
    setContextEngine(engine: any): void {
        this._contextEngine = engine
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setContextEngine(engine))
        })
    }

    /**
     * Set message storage for all existing and future agents.
     */
    setStorage(storage: any): void {
        this._storage = storage
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setStorage(storage))
        })
    }


    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: MentionMessage): Promise<void> {
        const agents = this.getAgents(roomId)
        const mentioned = resolveMentionTargets(agents, msg.content, msg.senderId)
        if (mentioned.length === 0) return

        logger.debug(`[AgentClients] ${mentioned.map(a => a.name).join(', ')} mentioned by ${msg.senderName}`)

        if (isAllAgentsMentioned(msg.content)) {
            for (const agent of mentioned) {
                try {
                    await this._processAgentMention(roomId, agent, msg)
                } catch (err: any) {
                    logger.error(`[AgentClients] error processing mention for ${agent.name}: ${err.message}`)
                }
            }
            return
        }

        for (const agent of mentioned) {
            this._processAgentMention(roomId, agent, msg).catch((err) => {
                logger.error(`[AgentClients] error processing mention for ${agent.name}: ${err.message}`)
            })
        }
    }

    /**
     * Process a single agent mention with status reporting and queue drain.
     */
    private async _processAgentMention(
        roomId: string,
        agent: AgentClient,
        msg: MentionMessage,
    ): Promise<void> {
        const agentKey = `${roomId}:${agent.name}`
        if (this._processingRooms.has(agentKey)) {
            // Queue for this specific agent
            let queue = this._mentionQueue.get(agentKey)
            if (!queue) {
                queue = []
                this._mentionQueue.set(agentKey, queue)
            }
            queue.push({ agent, msg })
            logger.debug(`[AgentClients] agent ${agent.name} is processing, queued mention in room ${roomId}`)
            return
        }

        this._processingRooms.add(agentKey)
        const onStatus = (status: 'compressing' | 'replying' | 'ready') => {
            agent.emitContextStatus(roomId, status)
            logger.debug(`[AgentClients] room ${roomId} agent ${agent.name} status: ${status}`)
        }

        try {
            await agent.replyToMention(roomId, msg, onStatus)
        } finally {
            this._processingRooms.delete(agentKey)
            await this._drainQueue(agentKey, roomId)
        }
    }

    /**
     * Drain queued mentions for a room after processing completes.
     */
    private async _drainQueue(agentKey: string, roomId: string): Promise<void> {
        const queue = this._mentionQueue.get(agentKey)
        if (!queue || queue.length === 0) return

        this._mentionQueue.delete(agentKey)
        logger.debug(`[AgentClients] draining ${queue.length} queued mention(s) for ${agentKey}`)

        // Process the last queued mention only (most recent, discards stale intermediate ones)
        const last = queue[queue.length - 1]
        await this._processAgentMention(roomId, last.agent, last.msg).catch((err) => {
            logger.error(`[AgentClients] error processing queued mention: ${err.message}`)
        })
    }
}

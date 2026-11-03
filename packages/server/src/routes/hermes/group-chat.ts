import Router from '@koa/router'
import {
    authenticatedGroupUserId,
    canManageGroupChatRoom,
    canReadGroupChatRoom,
    serializeGroupChatRoom,
    type GroupChatServer,
} from '../../services/hermes/group-chat'
import { isReservedMentionName } from '../../services/hermes/group-chat/mention-routing'

export const groupChatRoutes = new Router()

let chatServer: GroupChatServer | null = null

export function setGroupChatServer(server: GroupChatServer) {
    chatServer = server
}

export function getGroupChatServer(): GroupChatServer | null {
    return chatServer
}

function requestUser(ctx: any) {
    const user = ctx.state?.user
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null
}

function denyHidden(ctx: any): false {
    ctx.status = 404
    ctx.body = { error: 'Room not found' }
    return false
}

function requireRoomRead(ctx: any): boolean {
    const user = requestUser(ctx)
    return Boolean(chatServer && user && canReadGroupChatRoom(chatServer.getStorage() as any, ctx.params.roomId, user)) || denyHidden(ctx)
}

function requireRoomManage(ctx: any): boolean {
    const user = requestUser(ctx)
    return Boolean(chatServer && user && canManageGroupChatRoom(chatServer.getStorage() as any, ctx.params.roomId, user)) || denyHidden(ctx)
}

function requestUserCanUseProfile(ctx: any, profile: string): boolean {
    const user = requestUser(ctx)
    return Boolean(user && (user.role === 'super_admin' || user.profiles?.includes(profile)))
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 10; i++) {
        code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
}

function normalizedInviteCode(value: unknown): string | null {
    const code = typeof value === 'string' ? value.trim() : ''
    return /^[A-Za-z0-9_-]{8,64}$/.test(code) ? code : null
}

type AgentInput = { profile: string; name?: string; description?: string; invited?: boolean | number }

function sanitizeAgentConnectReason(reason?: string): string {
    return (reason || 'agent runtime connection failed')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[REDACTED]')
        .split('\n')[0]
        .slice(0, 240)
}

function agentConnectFailureBody(profile: string, err: any) {
    return {
        code: 'PROFILE_AGENT_CONNECT_FAILED',
        error: `Failed to connect agent "${profile}" to room`,
        profile,
        reason: sanitizeAgentConnectReason(err?.message),
    }
}

async function connectAndPersistRoomAgent(server: GroupChatServer, roomId: string, input: AgentInput, agentId = generateId()) {
    const profile = input.profile
    const name = input.name || profile
    const description = input.description || ''
    const invited = input.invited ? 1 : 0
    const client = await server.agentClients.createAgent({
        agentId,
        profile,
        name,
        description,
        invited,
    })

    try {
        await server.agentClients.addAgentToRoom(roomId, client)
        return server.getStorage().addRoomAgent(roomId, agentId, profile, name, description, invited)
    } catch (err) {
        server.agentClients.removeAgentFromRoom(roomId, client.agentId)
        throw err
    }
}

// Create room
groupChatRoutes.post('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const body = ctx.request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid room payload' }
        return
    }
    const { name, inviteCode: requestedInviteCode, agents, compression } = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
        compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
    }
    const inviteCode = normalizedInviteCode(requestedInviteCode)
    if (typeof name !== 'string' || !name.trim() || !inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'name and a valid inviteCode are required' }
        return
    }
    const user = requestUser(ctx)
    if (!user) {
        ctx.status = 403
        ctx.body = { error: 'Trusted user required' }
        return
    }
    if (agents !== undefined && (!Array.isArray(agents) || agents.some(agent => !agent || typeof agent.profile !== 'string' || !agent.profile.trim()))) {
        ctx.status = 400
        ctx.body = { error: 'Invalid agents payload' }
        return
    }
    const reservedAgent = (agents || []).find(a => isReservedMentionName(a.name || a.profile))
    if (reservedAgent) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }
    const unavailableAgent = (agents || []).find(agent => !requestUserCanUseProfile(ctx, agent.profile))
    if (unavailableAgent) {
        ctx.status = 403
        ctx.body = { error: 'Profile unavailable' }
        return
    }

    const roomId = generateId()
    const storage = chatServer.getStorage()
    if (storage.getRoomByInviteCode(inviteCode)) {
        ctx.status = 409
        ctx.body = { error: 'Invite code already exists' }
        return
    }
    storage.saveRoom(roomId, name.trim(), inviteCode, { ...compression, ownerAuthUserId: user.id })
    storage.addRoomMember(roomId, authenticatedGroupUserId(user.id), user.username, '', '', user.id)

    const addedAgents = []
    const agentResults = []
    for (const a of agents || []) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: a.profile,
                name: a.name || a.profile,
                description: a.description || '',
                invited: a.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: a.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect agent ${a.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(a.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = { room: room ? serializeGroupChatRoom(room as any, true) : room, agents: addedAgents, agentResults }
})

// Clone room roles/config without copying the conversation context.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clone', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const sourceRoom = chatServer.getStorage().getRoom(ctx.params.roomId)
    if (!sourceRoom) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!requireRoomManage(ctx)) return
    const user = requestUser(ctx)!
    const storage = chatServer.getStorage()
    const sourceAgents = storage.getRoomAgents(sourceRoom.id)
    if (sourceAgents.some(agent => !requestUserCanUseProfile(ctx, agent.profile))) {
        ctx.status = 403
        ctx.body = { error: 'Profile unavailable' }
        return
    }

    if (!ctx.request.body || typeof ctx.request.body !== 'object' || Array.isArray(ctx.request.body)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid clone payload' }
        return
    }
    const { name, inviteCode } = ctx.request.body as { name?: string; inviteCode?: string }
    if (name != null && typeof name !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'Invalid room name' }
        return
    }
    const roomId = generateId()
    const code = inviteCode == null || inviteCode === '' ? generateInviteCode() : normalizedInviteCode(inviteCode)
    if (!code) {
        ctx.status = 400
        ctx.body = { error: 'Invalid invite code' }
        return
    }
    if (storage.getRoomByInviteCode(code)) {
        ctx.status = 409
        ctx.body = { error: 'Invite code already exists' }
        return
    }
    storage.saveRoom(roomId, name?.trim() || `${sourceRoom.name} Copy`, code, {
        triggerTokens: sourceRoom.triggerTokens,
        maxHistoryTokens: sourceRoom.maxHistoryTokens,
        tailMessageCount: sourceRoom.tailMessageCount,
        ownerAuthUserId: user.id,
    })
    storage.addRoomMember(roomId, authenticatedGroupUserId(user.id), user.username, '', '', user.id)

    const addedAgents = []
    const agentResults = []
    for (const sourceAgent of sourceAgents) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: sourceAgent.profile,
                name: sourceAgent.name,
                description: sourceAgent.description,
                invited: sourceAgent.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: sourceAgent.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect cloned agent ${sourceAgent.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(sourceAgent.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = { room: room ? serializeGroupChatRoom(room as any, true) : room, agents: addedAgents, agentResults }
})

// Get room detail and messages
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const room = chatServer.getStorage().getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!requireRoomRead(ctx)) return
    const canManage = canManageGroupChatRoom(chatServer.getStorage() as any, ctx.params.roomId, requestUser(ctx)!)

    const offset = ctx.query.offset ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0) : 0
    const limit = ctx.query.limit ? Math.max(1, parseInt(ctx.query.limit as string, 10) || 150) : 150
    const messages = chatServer.getStorage().getMessages(ctx.params.roomId, limit, offset)
    const total = chatServer.getStorage().getMessageCount(ctx.params.roomId)
    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    const members = chatServer.getStorage().getRoomMembers(ctx.params.roomId)
    ctx.body = { room: serializeGroupChatRoom(room as any, canManage), messages, agents, members, total, offset, limit, hasMore: offset + messages.length < total }
})

// List rooms
groupChatRoutes.get('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const user = requestUser(ctx)
    const storage = chatServer.getStorage()
    if (!user) {
        ctx.status = 403
        ctx.body = { error: 'Trusted user required' }
        return
    }
    const rooms = user.role === 'super_admin'
        ? storage.getAllRooms()
        : storage.getRoomsForAuthUser(user.id)
    ctx.body = {
        rooms: rooms.map(room => serializeGroupChatRoom(
            room as any,
            canManageGroupChatRoom(storage as any, room.id, user),
        )),
    }
})

// Get room by invite code
groupChatRoutes.post('/api/hermes/group-chat/rooms/join/:code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const user = requestUser(ctx)
    if (!user) {
        ctx.status = 403
        ctx.body = { error: 'Trusted user required' }
        return
    }
    const room = chatServer.getStorage().joinRoomByInviteCode(ctx.params.code, user.id, user.username)
    if (!room?.ownerAuthUserId) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    ctx.body = { room: serializeGroupChatRoom(room as any, false) }
})

// Update room invite code
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/invite-code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const inviteCode = normalizedInviteCode((ctx.request.body as { inviteCode?: string })?.inviteCode)
    if (!inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'A valid inviteCode is required' }
        return
    }

    const existing = chatServer.getStorage().getRoomByInviteCode(inviteCode)
    if (existing && existing.id !== ctx.params.roomId) {
        ctx.status = 409
        ctx.body = { error: 'Invite code already exists' }
        return
    }

    chatServer.getStorage().updateRoomInviteCode(ctx.params.roomId, inviteCode)
    ctx.body = { success: true }
})

// Add agent to room
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const { profile, name, description, invited } = ctx.request.body as { profile?: string; name?: string; description?: string; invited?: boolean }
    if (!profile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (!chatServer.getStorage().isRoomProfileAuthorized(ctx.params.roomId, profile)) {
        ctx.status = 403
        ctx.body = { error: 'Profile unavailable to room owner' }
        return
    }
    if (isReservedMentionName(name || profile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    // Prevent duplicate agent in same room
    const existing = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    if (existing.find(a => a.profile === profile)) {
        ctx.status = 409
        ctx.body = { error: 'Agent already in room' }
        return
    }

    try {
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, {
            profile,
            name: name || profile,
            description: description || '',
            invited,
        })
        ctx.body = { agent }
    } catch (err: any) {
        console.error(`[GroupChat] Failed to connect agent ${profile} to room ${ctx.params.roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(profile, err)
    }
})

// List agents in room
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomRead(ctx)) return

    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    ctx.body = { agents }
})

// Remove agent from room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const roomId = ctx.params.roomId
    const requestedAgentId = ctx.params.agentId
    const storage = chatServer.getStorage()
    const agent = storage.getRoomAgent(roomId, requestedAgentId)
    if (!agent) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }

    storage.removeRoomMembersForAgent(roomId, agent)
    storage.removeRoomAgent(roomId, requestedAgentId)
    chatServer.agentClients.removeAgentFromRoom(roomId, agent.agentId)
    ctx.body = {
        success: true,
        agents: storage.getRoomAgents(roomId),
        members: storage.getRoomMembers(roomId),
    }
})

// Delete room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const roomId = ctx.params.roomId
    // Disconnect all agents in room
    chatServer.agentClients.disconnectRoom(roomId)
    // Delete all data
    chatServer.getStorage().deleteRoom(roomId)
    ctx.body = { success: true }
})

// Clear current room context while keeping members, agents, and room config.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clear-context', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const roomId = ctx.params.roomId
    if (!chatServer.getStorage().getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    chatServer.getStorage().clearRoomContext(roomId)
    chatServer.clearRoomRuntimeState(roomId)
    ctx.body = { success: true, room: chatServer.getStorage().getRoom(roomId) }
})

// Update room compression config
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/config', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const roomId = ctx.params.roomId
    const { triggerTokens, maxHistoryTokens, tailMessageCount } = ctx.request.body as {
        triggerTokens?: number
        maxHistoryTokens?: number
        tailMessageCount?: number
    }

    chatServer.getStorage().updateRoomConfig(roomId, { triggerTokens, maxHistoryTokens, tailMessageCount })
    const room = chatServer.getStorage().getRoom(roomId)
    ctx.body = { room }
})

// Force compress a room's context
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/compress', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    if (!requireRoomManage(ctx)) return

    const roomId = ctx.params.roomId
    if (!chatServer.getStorage().getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    const engine = chatServer.getContextEngine()
    if (!engine) {
        ctx.status = 503
        ctx.body = { error: 'Context engine not available' }
        return
    }

    try {
        const result = await engine.forceCompress(roomId)
        ctx.body = { success: true, summary: result }
    } catch (err: any) {
        ctx.status = 500
        ctx.body = { error: err.message }
    }
})

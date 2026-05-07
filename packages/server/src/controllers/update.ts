export async function handleUpdate(ctx: any) {
  ctx.status = 403
  ctx.body = {
    success: false,
    message: 'Web UI self-update is disabled. Run hermes-web-ui update from the server terminal instead.',
  }
}

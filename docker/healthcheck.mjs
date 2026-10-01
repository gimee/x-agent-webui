// Check the live HTTP/auth contract, not just a listening TCP port.
const origin = `http://127.0.0.1:${process.env.PORT || '6060'}`
try {
  const status = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(4000), redirect: 'error' })
  if (!status.ok || (await status.json()).hasPasswordLogin !== true) {
    throw new Error('password login is not available')
  }
  const protectedEndpoint = await fetch(`${origin}/api/auth/me`, { signal: AbortSignal.timeout(4000), redirect: 'error' })
  if (protectedEndpoint.status !== 401) throw new Error('unauthenticated API request was not rejected')
} catch (error) {
  console.error(`Unhealthy WebUI: ${error.message}`)
  process.exitCode = 1
}

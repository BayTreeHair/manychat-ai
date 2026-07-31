export function GET() {
  return Response.json({ status: 'ok', uptime: process.uptime() });
}

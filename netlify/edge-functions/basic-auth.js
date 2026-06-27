const COOKIE = "_gwauth";

export default async function handler(req, context) {
  const password = Deno.env.get("SITE_PASSWORD");
  if (!password) return context.next();

  const url = new URL(req.url);

  // Handle password form POST
  if (req.method === "POST" && url.pathname === "/login") {
    const body = await req.formData().catch(() => null);
    const pw = body ? body.get("pw") : null;
    if (pw === password) {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": `${COOKIE}=${password}; Path=/; HttpOnly; Secure; SameSite=Strict`,
        },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { "Location": "/login?error=1" },
    });
  }

  // Always allow the login page through
  if (url.pathname === "/login") return context.next();

  // Check cookie on all other routes
  const cookies = req.headers.get("cookie") || "";
  const match = cookies.split(";").find(c => c.trim().startsWith(COOKIE + "="));
  const val = match ? match.trim().slice(COOKIE.length + 1) : null;
  if (val === password) return context.next();

  // Not authenticated — send to login page
  return new Response(null, {
    status: 302,
    headers: { "Location": "/login" },
  });
}

export const config = { path: "/*" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const path = req.url.replace(/^\/api\/index/, "") || "/";
  if (path === "/ping") {
    return res.status(200).send("VERCEL_ALIVE");
  }

  const targetUrl = "https://riapxjwtalqvaevsnpnb.supabase.co" + path;

  const headers = {
    "apikey": req.headers["apikey"] || "",
    "authorization": req.headers["authorization"] || "",
    "content-type": req.headers["content-type"] || "application/json",
    "accept": req.headers["accept"] || "*/*"
  };
  if (req.headers["x-client-info"]) headers["x-client-info"] = req.headers["x-client-info"];
  if (req.headers["x-upsert"]) headers["x-upsert"] = req.headers["x-upsert"];
  if (req.headers["range"]) headers["range"] = req.headers["range"];

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) body = Buffer.concat(chunks);
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body
    });

    const data = await response.arrayBuffer();
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(Buffer.from(data));
  } catch (e) {
    return res.status(502).json({
      error: "Proxy error",
      message: e.message,
      cause: e.cause ? String(e.cause) : "none",
      targetUrl
    });
  }
}

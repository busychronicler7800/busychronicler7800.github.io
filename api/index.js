module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "apikey, authorization, content-type, x-client-info, x-upsert, range, accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const rawPath = req.url === "/api/index" ? "/" : req.url;
  if (rawPath === "/ping") {
    return res.status(200).send("VERCEL_ALIVE");
  }

  const targetUrl = `https://jxqezqwrzpfujktnouyz.supabase.co${rawPath}`;

  const headers = {};
  for (const key of ["apikey", "authorization", "content-type", "x-client-info", "x-upsert", "range", "accept"]) {
    if (req.headers[key]) {
      headers[key] = req.headers[key];
    }
  }

  let body = undefined;
  if (!["GET", "HEAD"].includes(req.method)) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      body = Buffer.concat(chunks);
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("Access-Control-Allow-Origin", "*");

    const arrayBuf = await upstream.arrayBuffer();
    return res.status(upstream.status).send(Buffer.from(arrayBuf));
  } catch (err) {
    return res.status(502).json({ error: "Proxy error", detail: err.message });
  }
};

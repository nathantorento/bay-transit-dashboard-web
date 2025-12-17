export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const stopcode = String(req.query.stopcode || "").trim();
    if (!/^\d{5}$/.test(stopcode)) {
      res.status(400).json({ error: "Invalid stopcode (must be 5 digits)" });
      return;
    }

    const password = String(req.headers["x-owner-password"] || "").trim();
    const expected = process.env.OWNER_PASSWORD;

    if (!expected) {
      res.status(500).json({ error: "Server missing OWNER_PASSWORD" });
      return;
    }

    if (password !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ownerToken = process.env.OWNER_511_TOKEN;
    if (!ownerToken) {
      res.status(500).json({ error: "Server missing OWNER_511_TOKEN" });
      return;
    }

    const url = new URL("https://api.511.org/transit/StopMonitoring");
    url.search = new URLSearchParams({
      api_key: ownerToken,
      agency: "SF",
      stopcode,
      format: "json",
    }).toString();

    const upstream = await fetch(url);
    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
}

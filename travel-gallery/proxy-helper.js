/* Route outbound HTTPS through a proxy when HTTPS_PROXY is set
   (corporate networks, CI sandboxes). No-op everywhere else. */
let cached = null;

function proxyAgent() {
  if (cached !== null) return cached || undefined;
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) { cached = false; return undefined; }
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    cached = new HttpsProxyAgent(p);
  } catch { cached = false; }
  return cached || undefined;
}

/* AWS SDK request handler that respects the proxy, or undefined */
function s3RequestHandler() {
  const agent = proxyAgent();
  if (!agent) return undefined;
  try {
    const { NodeHttpHandler } = require("@smithy/node-http-handler");
    return new NodeHttpHandler({ httpsAgent: agent });
  } catch { return undefined; }
}

module.exports = { proxyAgent, s3RequestHandler };

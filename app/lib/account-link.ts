export type AccountConnection = { walletAddress: string; privateKey: string; signatureType: string };

export type AccountLinkPlan =
  | { kind: "live-session"; url: "/api/polymarket/live"; body: { action: "connect"; walletAddress: string; privateKey: string; signatureType: number } }
  | { kind: "wallet-only"; url: "/api/polymarket/account"; body: { walletAddress: string; signatureType: string } };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLoopbackHostname = (hostname: string) => LOOPBACK_HOSTS.has(hostname.toLowerCase());

/**
 * The request the browser sends to link an account. A raw signer key is only
 * ever placed in a request when the page itself is served from this machine;
 * a hosted page builds a wallet-only request that carries no key field at all.
 */
export const accountLinkPlan = (connection: AccountConnection, pageHostname: string): AccountLinkPlan => {
  const walletAddress = connection.walletAddress.trim();
  if (isLoopbackHostname(pageHostname) && connection.privateKey.trim()) {
    return { kind: "live-session", url: "/api/polymarket/live",
      body: { action: "connect", walletAddress, privateKey: connection.privateKey.trim(), signatureType: Number(connection.signatureType) } };
  }
  return { kind: "wallet-only", url: "/api/polymarket/account", body: { walletAddress, signatureType: connection.signatureType } };
};

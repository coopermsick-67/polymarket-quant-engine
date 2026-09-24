import { chatGPTSignInPath, getChatGPTUser } from "../chatgpt-auth";

export default async function ChatGPTAuthBanner() {
  const user = await getChatGPTUser();

  return user ? (
    <aside className="chatgpt-auth-banner is-authenticated" aria-label="ChatGPT sign-in status">
      <span className="chatgpt-auth-dot" />
      <span>ChatGPT signed in</span>
    </aside>
  ) : (
    <aside className="chatgpt-auth-banner" aria-label="ChatGPT sign-in required">
      <span>Sign in with ChatGPT before connecting a wallet.</span>
      <a href={chatGPTSignInPath("/")} target="_top">SIGN IN</a>
    </aside>
  );
}

const TOKEN_KEY = "mainline-notebook.cloud-access-token";

let supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
let publishableKey = String(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || "",
);

export function cloudAuthEnabled(): boolean {
  return Boolean(supabaseUrl && publishableKey);
}

export async function loadCloudAuthConfig(): Promise<boolean> {
  const response = await fetch("/api/client-config", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取登录配置。");
  const config = await response.json();
  if (!config?.cloudMode) return false;
  supabaseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  publishableKey = String(config.supabasePublishableKey || "");
  if (!cloudAuthEnabled()) throw new Error("云端登录配置不完整。");
  return true;
}

export function getAccessToken(): string {
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function clearAccessToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function completeAuthRedirect(): boolean {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = hash.get("access_token");
  if (!accessToken) return false;
  window.localStorage.setItem(TOKEN_KEY, accessToken);
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  return true;
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!cloudAuthEnabled()) throw new Error("云端登录尚未配置完成。");
  const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      create_user: false,
      gotrue_meta_security: {},
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        shouldCreateUser: false,
      },
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.msg || payload?.message || "登录邮件暂时无法发送。");
  }
}

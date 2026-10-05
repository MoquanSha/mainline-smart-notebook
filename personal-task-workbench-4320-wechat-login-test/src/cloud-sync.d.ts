export {};

declare global {
  interface MainlineHomeStatus {
    enabled: boolean;
    port: number;
    localUrl: string;
    publicUrl?: string;
    token?: string;
    tunnel: {
      configured: boolean;
      connected: boolean;
      state: string;
      lastError?: string;
      lastConnectedAt?: string;
      publicEndpoint?: string;
      relayBaseUrl?: string;
      homeId?: string;
    };
  }

  interface Window {
    mainlineAccounts?: {
      list(): Promise<Array<{ profileKey: string; displayName: string; connected: boolean }>>;
      current(): Promise<unknown>;
      switchAccount(): Promise<unknown>;
      logout(): Promise<unknown>;
    };
    mainlineCloud?: {
      pair(options: { endpoint: string; pairCode: string }): Promise<{
        connected: boolean;
        endpoint: string;
        pairedAt: string;
      }>;
      sync(): Promise<{
        connected: boolean;
        pulled: number;
        pushed: number;
        conflicts: number;
        lastSyncAt: string;
      }>;
      status(): Promise<{
        connected: boolean;
        endpoint?: string;
        pairedAt?: string;
        lastSyncAt?: string;
        disabled?: boolean;
        localOnly?: boolean;
      }>;
      disconnect(): Promise<{ connected: boolean }>;
      onRemoteApplied(listener: (result: {
        pulled: number;
        pushed: number;
        conflicts: number;
        lastSyncAt: string;
      }) => void): () => void;
    };
    mainlineHome?: {
      status(): Promise<MainlineHomeStatus>;
      setPublicUrl(publicUrl: string): Promise<MainlineHomeStatus>;
      configureTunnel(options: {
        relayBaseUrl: string;
        homeId: string;
        tunnelToken: string;
      }): Promise<MainlineHomeStatus>;
      restartTunnel(): Promise<MainlineHomeStatus>;
      disconnectTunnel(): Promise<MainlineHomeStatus>;
    };
  }
}

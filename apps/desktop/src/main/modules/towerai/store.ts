export interface TowerAITokenState {
  authToken: string;
  lastRefreshAt?: string;
  token: string;
}

export interface TowerAIAuthState {
  connected: boolean;
  expiresSoon: boolean;
  hasToken: boolean;
  lastRefreshAt?: string;
  loggedIn: boolean;
}

class TowerAIStore {
  private state: TowerAITokenState = { authToken: '', token: '' };

  get(): TowerAITokenState {
    return { ...this.state };
  }

  set(state: TowerAITokenState): void {
    this.state = { ...state, lastRefreshAt: new Date().toISOString() };
    // Sync to process.env so the Next.js server (same process) can read them
    process.env.TOWERAI_API_KEY = state.token;
    process.env.TOWERAI_AUTH_TOKEN = state.authToken;
  }

  clear(): void {
    this.state = { authToken: '', token: '' };
    delete process.env.TOWERAI_API_KEY;
    delete process.env.TOWERAI_AUTH_TOKEN;
  }

  getAuthState(): TowerAIAuthState {
    return {
      connected: true,
      expiresSoon: false,
      hasToken: Boolean(this.state.token),
      lastRefreshAt: this.state.lastRefreshAt,
      loggedIn: Boolean(this.state.token),
    };
  }
}

export const towerAIStore = new TowerAIStore();

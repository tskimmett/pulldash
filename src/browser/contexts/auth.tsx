import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

// Storage keys
const TOKEN_STORAGE_KEY = "pulldash_github_token";
const TOKEN_EXPIRY_KEY = "pulldash_github_token_expiry";

// ============================================================================
// Types
// ============================================================================

interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  // Rate limit state
  isRateLimited: boolean;
}

interface AuthContextValue extends AuthState {
  loginWithPAT: (token: string) => Promise<void>;
  logout: () => void;
  // Check if user can write (authenticated)
  canWrite: boolean;
  // Set rate limit state (called by GitHub context when rate limited)
  setRateLimited: (limited: boolean) => void;
}

// ============================================================================
// Context
// ============================================================================

const AuthContext = createContext<AuthContextValue | null>(null);

// ============================================================================
// Helper Functions
// ============================================================================

function getStoredToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);

    // Check if token exists and hasn't expired
    if (token) {
      if (expiry) {
        const expiryDate = new Date(expiry);
        if (expiryDate > new Date()) {
          return token;
        }
        // Token expired, clear it
        clearStoredToken();
        return null;
      }
      // No expiry set, token is valid (GitHub tokens don't expire unless revoked)
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

function storeToken(token: string, expiresIn?: number): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    if (expiresIn) {
      const expiryDate = new Date(Date.now() + expiresIn * 1000);
      localStorage.setItem(TOKEN_EXPIRY_KEY, expiryDate.toISOString());
    }
  } catch {
    console.error("Failed to store token in localStorage");
  }
}

function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  } catch {
    // Ignore
  }
}

// ============================================================================
// Provider
// ============================================================================

/**
 * Classic PATs report their scopes and need full `repo` (not just
 * `public_repo`). Fine-grained PATs report none; their per-repo permissions
 * are enforced by GitHub on each call.
 */
export function hasRequiredScopes(
  token: string,
  scopesHeader: string | null
): boolean {
  if (token.startsWith("github_pat_")) return true;
  const scopes = (scopesHeader ?? "").split(",").map((s) => s.trim());
  return scopes.includes("repo");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = getStoredToken();
    return {
      isAuthenticated: !!token,
      token,
      isRateLimited: false,
    };
  });

  // Set rate limit state
  const setRateLimited = useCallback((limited: boolean) => {
    setState((prev) => ({ ...prev, isRateLimited: limited }));
  }, []);

  const loginWithPAT = useCallback(async (token: string): Promise<void> => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new Error("Token cannot be empty");
    }

    // Validate token format (GitHub PAT prefixes)
    if (
      !trimmedToken.startsWith("ghp_") &&
      !trimmedToken.startsWith("github_pat_")
    ) {
      throw new Error(
        'Invalid token format. GitHub tokens should start with "ghp_" or "github_pat_"'
      );
    }

    // Validate token directly with GitHub API (CORS is supported)
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Invalid or expired token");
      }
      throw new Error("Failed to validate token with GitHub");
    }

    const userData = await response.json();

    if (
      !hasRequiredScopes(trimmedToken, response.headers.get("x-oauth-scopes"))
    ) {
      throw new Error(
        'Token is missing the required "repo" scope. Please create a new token with the repo scope.'
      );
    }

    // Store token
    storeToken(trimmedToken);
    setState({
      isAuthenticated: true,
      token: trimmedToken,
      isRateLimited: false,
    });

    console.log("Successfully authenticated with PAT as:", userData.login);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setState({
      isAuthenticated: false,
      token: null,
      isRateLimited: false,
    });
  }, []);

  const value: AuthContextValue = {
    ...state,
    loginWithPAT,
    logout,
    canWrite: state.isAuthenticated,
    setRateLimited,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ============================================================================
// Hooks
// ============================================================================

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export function useToken(): string | null {
  const { token } = useAuth();
  return token;
}

export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
}

export function useCanWrite(): boolean {
  const { canWrite } = useAuth();
  return canWrite;
}

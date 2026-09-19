import { atom } from 'nanostores';
import type { VercelConnection, VercelUser } from '~/types/vercel';
import { AUTO_DEPLOY_SETTING_KEY, isAutoDeployEnabled } from '~/lib/utils/autoDeploy';
import { logStore } from './logs';
import { toast } from 'react-toastify';

// Auto-connect using environment variable
const envToken = import.meta.env?.VITE_VERCEL_ACCESS_TOKEN;

// Initialize with stored connection or defaults
const storedConnection = typeof window !== 'undefined' ? localStorage.getItem('vercel_connection') : null;
let initialConnection: VercelConnection;

if (storedConnection) {
  try {
    const parsed = JSON.parse(storedConnection);

    // If we have a stored connection but no user and no token, clear it and use env token
    if (!parsed.user && !parsed.token && envToken) {
      console.log('Vercel store: Clearing incomplete saved connection, using env token');

      if (typeof window !== 'undefined') {
        localStorage.removeItem('vercel_connection');
      }

      initialConnection = {
        user: null,
        token: envToken,
        stats: undefined,
      };
    } else {
      initialConnection = parsed;
    }
  } catch (error) {
    console.error('Error parsing saved Vercel connection:', error);
    initialConnection = {
      user: null,
      token: envToken || '',
      stats: undefined,
    };
  }
} else {
  initialConnection = {
    user: null,
    token: envToken || '',
    stats: undefined,
  };
}

export const vercelConnection = atom<VercelConnection>(initialConnection);
export const isConnecting = atom<boolean>(false);
export const isFetchingStats = atom<boolean>(false);

/**
 * Deploy to Vercel automatically once a generated app is running. Opt-out via
 * Settings -> Vercel; the preference survives reloads.
 */
export const vercelAutoDeploy = atom<boolean>(
  isAutoDeployEnabled(typeof window !== 'undefined' ? localStorage.getItem(AUTO_DEPLOY_SETTING_KEY) : null),
);

export function setVercelAutoDeploy(enabled: boolean) {
  vercelAutoDeploy.set(enabled);

  if (typeof window !== 'undefined') {
    localStorage.setItem(AUTO_DEPLOY_SETTING_KEY, enabled ? 'true' : 'false');
  }

  logStore.logProvider(`Vercel auto-deploy ${enabled ? 'enabled' : 'disabled'}`, { source: 'vercel' });
}

export const updateVercelConnection = (updates: Partial<VercelConnection>) => {
  const currentState = vercelConnection.get();
  const newState = { ...currentState, ...updates };
  vercelConnection.set(newState);

  // Persist to localStorage
  if (typeof window !== 'undefined') {
    localStorage.setItem('vercel_connection', JSON.stringify(newState));
  }
};

/**
 * Verify a Vercel token and return the account behind it.
 *
 * A browser-held token is checked against the Vercel API directly (bolt never sees it).
 * If that is not possible — no client token, a CSP/network block, or a token that only
 * lives in the server environment — we fall back to `/api/vercel-user`, which resolves
 * `VERCEL_TOKEN` server-side.
 */
async function verifyVercelToken(
  token?: string,
): Promise<{ user: VercelUser; token?: string; source: 'client' | 'server' }> {
  if (token) {
    try {
      const response = await fetch('https://api.vercel.com/v2/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const userData = (await response.json()) as any;

        return { user: (userData.user ?? userData) as VercelUser, token, source: 'client' };
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error('Vercel rejected the token (401/403). Check that it is still valid.');
      }
    } catch (error) {
      const isNetworkError = error instanceof TypeError;

      if (!isNetworkError) {
        throw error;
      }

      console.warn('Vercel: direct browser check unavailable, falling back to /api/vercel-user');
    }
  }

  const response = await fetch('/api/vercel-user');

  if (response.status === 401) {
    return Promise.reject(new Error('No Vercel token configured (neither in the browser nor in .env.local)'));
  }

  if (!response.ok) {
    throw new Error(`Vercel API error: ${response.status}`);
  }

  const user = (await response.json()) as VercelUser;

  if (!user || (!user.id && !user.username)) {
    throw new Error('Vercel server route did not return a user');
  }

  return { user, source: 'server' };
}

// Auto-connect using an environment token, or a server-side VERCEL_TOKEN
export async function autoConnectVercel() {
  console.log('autoConnectVercel called, envToken exists:', !!envToken);

  try {
    isConnecting.set(true);

    const { user, token, source } = await verifyVercelToken(envToken);

    updateVercelConnection({
      user,
      token: token ?? '',
      tokenSource: source,
    });

    logStore.logInfo('Auto-connected to Vercel', {
      type: 'system',
      message: `Auto-connected to Vercel as ${user.username ?? user.email ?? 'unknown'} (${source}-side token)`,
    });

    // Project stats need a token the browser can use, so only fetch them in that mode.
    if (token) {
      await fetchVercelStats(token);
    } else {
      await fetchVercelStatsViaServer();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to auto-connect to Vercel:', error);
    logStore.logError(`Vercel auto-connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
      type: 'system',
      message: 'Vercel auto-connection failed',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    isConnecting.set(false);
  }
}

/**
 * Called when the workbench mounts: unlocks the "Deploy to Vercel" action for a freshly
 * created app without requiring the user to open Settings first.
 */
export async function initializeVercelConnection() {
  const current = vercelConnection.get();

  if (current.user) {
    return current;
  }

  return autoConnectVercel();
}

let bootstrapStarted = false;

/**
 * Fire-and-forget variant used by the UI: connects at most once per page load so a
 * re-render cannot start several token checks in parallel.
 */
export function bootstrapVercelConnection() {
  if (bootstrapStarted || typeof window === 'undefined') {
    return;
  }

  bootstrapStarted = true;

  initializeVercelConnection().catch((error) => {
    console.debug('Vercel bootstrap skipped:', error);
  });
}

/** Stats through bolt's own route, so the secret can stay on the server. */
async function fetchVercelStatsViaServer() {
  try {
    const response = await fetch('/api/vercel-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=get_projects',
    });

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as any;

    if (!data?.projects) {
      return;
    }

    updateVercelConnection({
      ...vercelConnection.get(),
      stats: {
        projects: data.projects,
        totalProjects: data.totalProjects ?? data.projects.length,
      },
    });
  } catch (error) {
    console.error('Vercel server-side stats error:', error);
  }
}

export const fetchVercelStatsViaAPI = fetchVercelStats;

export async function fetchVercelStats(token: string) {
  try {
    isFetchingStats.set(true);

    const projectsResponse = await fetch('https://api.vercel.com/v9/projects', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!projectsResponse.ok) {
      throw new Error(`Failed to fetch projects: ${projectsResponse.status}`);
    }

    const projectsData = (await projectsResponse.json()) as any;
    const projects = projectsData.projects || [];

    // Fetch latest deployment for each project
    const projectsWithDeployments = await Promise.all(
      projects.map(async (project: any) => {
        try {
          const deploymentsResponse = await fetch(
            `https://api.vercel.com/v6/deployments?projectId=${project.id}&limit=1`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            },
          );

          if (deploymentsResponse.ok) {
            const deploymentsData = (await deploymentsResponse.json()) as any;
            return {
              ...project,
              latestDeployments: deploymentsData.deployments || [],
            };
          }

          return project;
        } catch (error) {
          console.error(`Error fetching deployments for project ${project.id}:`, error);
          return project;
        }
      }),
    );

    const currentState = vercelConnection.get();
    updateVercelConnection({
      ...currentState,
      stats: {
        projects: projectsWithDeployments,
        totalProjects: projectsWithDeployments.length,
      },
    });
  } catch (error) {
    console.error('Vercel API Error:', error);
    logStore.logError('Failed to fetch Vercel stats', { error });
    toast.error('Failed to fetch Vercel statistics');
  } finally {
    isFetchingStats.set(false);
  }
}

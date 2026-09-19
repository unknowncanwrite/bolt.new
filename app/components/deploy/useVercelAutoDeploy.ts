import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { computed } from 'nanostores';
import { toast } from 'react-toastify';
import { chatId } from '~/lib/persistence/useChatHistory';
import { vercelAutoDeploy, vercelConnection, bootstrapVercelConnection } from '~/lib/stores/vercel';
import { streamingState } from '~/lib/stores/streaming';
import { workbenchStore } from '~/lib/stores/workbench';
import { logStore } from '~/lib/stores/logs';
import { AUTO_DEPLOY_SETTLE_MS, autoDeployChatKey, shouldTriggerAutoDeploy } from '~/lib/utils/autoDeploy';
import { useVercelDeploy } from './VercelDeploy.client';

/**
 * Ships the app to Vercel the moment generation is finished, so a created project does not
 * have to be deployed by hand.
 *
 * Conditions (see `shouldTriggerAutoDeploy`): the model stopped streaming, the generated app
 * is actually running (its preview is up, which also means `npm install` finished), a Vercel
 * account is reachable, and this chat has not been auto-deployed during this page view yet.
 */
export function useVercelAutoDeploy() {
  const enabled = useStore(vercelAutoDeploy);
  const connection = useStore(vercelConnection);
  const isStreaming = useStore(streamingState);
  const hasPreview = useStore(computed(workbenchStore.previews, (previews) => previews.length > 0));
  const currentChatId = useStore(chatId);
  const { handleVercelDeploy, isDeploying } = useVercelDeploy();

  /** Chats already shipped in this page view (also guards against re-running on re-render). */
  const deployedChats = useRef<Set<string>>(new Set());
  const generationChatId = useRef<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const chatKey = autoDeployChatKey(currentChatId);
  const connected = !!connection.user || !!connection.token;

  /*
   * A deployment is pointless for a chat that was only loaded from history, so remember which
   * chat streamed in this view rather than trusting "not streaming" alone.
   */
  useEffect(() => {
    if (isStreaming) {
      generationChatId.current = currentChatId ?? null;
    }
  }, [isStreaming, currentChatId]);

  const deploy = useCallback(async () => {
    if (deployedChats.current.has(chatKey)) {
      return;
    }

    // Claim the chat up front: a failing deploy must not loop forever against the same project.
    deployedChats.current.add(chatKey);

    logStore.logProvider('Auto-deploying generated app to Vercel', { chatId: currentChatId });
    toast.info('Auto-deploying to Vercel…');

    const result = await handleVercelDeploy();

    if (!result) {
      logStore.logProvider('Vercel auto-deploy did not complete', { chatId: currentChatId });
    }
  }, [chatKey, currentChatId, handleVercelDeploy]);

  /*
   * The preview is up but nothing is connected yet (the token check is still in flight), so kick
   * it once and let the next store update re-run the scheduling effect below.
   */
  useEffect(() => {
    if (enabled && !connected && hasPreview && !isStreaming) {
      bootstrapVercelConnection();
    }
  }, [enabled, connected, hasPreview, isStreaming]);

  useEffect(() => {
    const shouldDeploy = shouldTriggerAutoDeploy({
      enabled,
      connected,
      isStreaming,
      hasPreview,
      sawGeneration: generationChatId.current === (currentChatId ?? null) && currentChatId != null,
      inFlight: isDeploying,
      alreadyDeployed: deployedChats.current.has(chatKey),
    });

    if (shouldDeploy) {
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = undefined;
        deploy().catch((error) => console.error('Vercel auto-deploy failed:', error));
      }, AUTO_DEPLOY_SETTLE_MS);
    }

    // Any change of state (a new message, a cancelled run) cancels a pending deploy.
    return () => {
      if (pendingTimer.current) {
        clearTimeout(pendingTimer.current);
        pendingTimer.current = undefined;
      }
    };
  }, [enabled, connected, isStreaming, hasPreview, isDeploying, chatKey, currentChatId, deploy]);
}

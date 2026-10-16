import { useCallback, useEffect, useRef, useState } from 'react';
import { official, errorMessage } from './official';
import type { OfficialUser, ShelfEntry } from './official';

export function useOfficialAccount() {
  const [user, setUser] = useState<OfficialUser | null>(null);
  const [checking, setChecking] = useState(official.available);
  const [accountError, setAccountError] = useState('');
  const [shelf, setShelf] = useState<ShelfEntry[]>([]);
  const [shelfBusy, setShelfBusy] = useState(false);
  const [shelfError, setShelfError] = useState('');
  const [shelfWarning, setShelfWarning] = useState('');
  const [shelfLoaded, setShelfLoaded] = useState(false);
  const mounted = useRef(false);
  const userRef = useRef<OfficialUser | null>(null);
  const accountGeneration = useRef(0);
  const shelfGeneration = useRef(0);
  const shelfRequest = useRef<number | null>(null);
  const accountRequest = useRef<Promise<OfficialUser | null> | null>(null);

  const acceptUser = useCallback((next: OfficialUser | null) => {
    accountGeneration.current++;
    if (userRef.current?.id !== next?.id) {
      shelfGeneration.current++;
      shelfRequest.current = null;
      setShelf([]); setShelfLoaded(false); setShelfBusy(false);
      setShelfError(''); setShelfWarning('');
    }
    userRef.current = next;
    setUser(next); setChecking(false); setAccountError('');
  }, []);

  const checkAccount = useCallback(async () => {
    if (!official.available()) { setChecking(false); return; }
    const generation = ++accountGeneration.current;
    setChecking(true); setAccountError('');
    // Reuse the in-flight request, including React's development effect replay.
    const request = accountRequest.current ?? official.account();
    accountRequest.current = request;
    try {
      const next = await request;
      if (mounted.current && generation === accountGeneration.current) acceptUser(next);
    } catch (e) {
      if (mounted.current && generation === accountGeneration.current) setAccountError(errorMessage(e));
    } finally {
      if (accountRequest.current === request) accountRequest.current = null;
      if (mounted.current && generation === accountGeneration.current) setChecking(false);
    }
  }, [acceptUser]);

  const refreshShelf = useCallback(async () => {
    const accountId = userRef.current?.id;
    if (!accountId || shelfRequest.current !== null) return;
    const generation = ++shelfGeneration.current;
    shelfRequest.current = generation;
    setShelfBusy(true); setShelfError('');
    try {
      const result = await official.bookshelf();
      if (!mounted.current || generation !== shelfGeneration.current || userRef.current?.id !== accountId) return;
      if (!Array.isArray(result.entries)) throw new Error('官方书架格式已变化');
      setShelf(result.entries); setShelfLoaded(true);
      setShelfWarning([result.progressError, result.metadataWarning].filter(Boolean).join(' · '));
    } catch (e) {
      if (mounted.current && generation === shelfGeneration.current) setShelfError(errorMessage(e));
    } finally {
      if (shelfRequest.current === generation) shelfRequest.current = null;
      if (mounted.current && generation === shelfGeneration.current) setShelfBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void checkAccount();
    return () => {
      mounted.current = false;
      accountGeneration.current++;
      shelfGeneration.current++;
    };
  }, [checkAccount]);

  useEffect(() => {
    if (user?.id) void refreshShelf();
  }, [user?.id, refreshShelf]);

  return { user, checking, accountError, checkAccount, acceptUser,
    shelf, shelfBusy, shelfError, shelfWarning, shelfLoaded, refreshShelf };
}

export type OfficialAccountState = ReturnType<typeof useOfficialAccount>;

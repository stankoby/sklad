import { useState, useEffect, useCallback } from 'react';
import { getSyncStatus, syncProducts } from '../api';

export function useSync() {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await getSyncStatus();
      setStatus(data);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const { data } = await syncProducts();
      await fetchStatus();
      return data;
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      throw err;
    } finally {
      setSyncing(false);
    }
  }, [fetchStatus]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  return { status, syncing, error, sync, refresh: fetchStatus };
}

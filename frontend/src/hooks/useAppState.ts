import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AppState } from '../lib/types';

export function useAppState() {
  return useQuery({
    queryKey: ['app-state'],
    queryFn: () => api<AppState>('/api/state'),
    refetchInterval: 5000,
    staleTime: 1500,
  });
}

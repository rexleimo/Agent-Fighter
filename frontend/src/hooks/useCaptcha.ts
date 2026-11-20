import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Fetches the current arithmetic challenge from the server. Only the question
 * text is exposed here: the answer and token stay server-side in an httpOnly
 * cookie that the browser sends automatically with the credential request.
 */
export function useCaptcha() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return api<{ question: string; left: number; op: '+' | '-'; right: number }>('/api/captcha')
      .then((data) => setQuestion(data.question))
      .catch(() => setQuestion(''))
      .then(() => setLoading(false));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { question, loading, refresh };
}

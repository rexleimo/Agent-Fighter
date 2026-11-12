const LABELS = ['太短', '偏弱', '可用', '较强', '很强'] as const;
const TONES = ['bad', 'bad', 'ok', 'good', 'good'] as const;

export function scorePassword(value: string): number {
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  return Math.min(4, score);
}

export function PasswordStrength({ value }: { value: string }) {
  const score = scorePassword(value);
  return (
    <div className="auth-strength" aria-live="polite">
      <div className="auth-strength-bars">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < score ? `on ${TONES[score]}` : undefined} />
        ))}
      </div>
      <span>密码强度：<b className={TONES[score]}>{LABELS[score]}</b></span>
    </div>
  );
}

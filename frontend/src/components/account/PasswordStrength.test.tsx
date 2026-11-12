import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PasswordStrength, scorePassword } from './PasswordStrength';

describe('scorePassword', () => {
  it('scores short passwords as the lowest band', () => {
    expect(scorePassword('abc')).toBe(0);
  });

  it('scores a long mixed password at the top band', () => {
    expect(scorePassword('Longer-Pass-123')).toBe(4);
  });

  it('never exceeds four bars', () => {
    expect(scorePassword('aVeryLong-Pass-123!')).toBeLessThanOrEqual(4);
  });
});

describe('PasswordStrength', () => {
  it('renders the strength label for the current value', () => {
    render(<PasswordStrength value="Longer-Pass-123" />);
    expect(screen.getByText('密码强度：')).toBeInTheDocument();
    expect(screen.getByText('很强')).toBeInTheDocument();
  });
});

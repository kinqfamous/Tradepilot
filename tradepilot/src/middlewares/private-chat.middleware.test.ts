import { describe, expect, it } from 'vitest';
import { isPublicChatUpdateAllowed } from './private-chat.middleware';

describe('public-chat security policy', () => {
  it.each(['/pnl', '/pnl@TradePilotBot', '/positions', '/markets', '/help'])(
    'allows the public read command %s',
    (command) => expect(isPublicChatUpdateAllowed(command)).toBe(true),
  );

  it.each(['/start', '/trade', '/close SOL-PERP', '/closeall', '/balance', '/fund', '/withdraw', '/settings', '/link', '/history', '/admin'])(
    'blocks the sensitive command %s',
    (command) => expect(isPublicChatUpdateAllowed(command)).toBe(false),
  );

  it('allows public market discovery text and callbacks', () => {
    expect(isPublicChatUpdateAllowed('What is SOL doing?')).toBe(true);
    expect(isPublicChatUpdateAllowed(undefined, 'markets_page_2')).toBe(true);
    expect(isPublicChatUpdateAllowed(undefined, 'grouptrade|LONG|SOL-PERP')).toBe(true);
  });

  it.each(['confirm', 'close_position|SOL-PERP|100', 'close_all_request', 'settings_export_wallet', 'admin_mode_emergency'])(
    'blocks the sensitive callback %s',
    (callback) => expect(isPublicChatUpdateAllowed(undefined, callback)).toBe(false),
  );

  it('blocks private reply-keyboard actions while retaining public positions', () => {
    expect(isPublicChatUpdateAllowed('📈 Trade')).toBe(false);
    expect(isPublicChatUpdateAllowed('💸 Withdraw')).toBe(false);
    expect(isPublicChatUpdateAllowed('📊 Positions')).toBe(true);
  });
});

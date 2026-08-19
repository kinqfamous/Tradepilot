import { Scenes, Context } from 'telegraf';

export interface OnboardingWizardState {
  acceptedTerms?: boolean;
  phoenixReferralCode?: string;
  linkMethod?: 'generate' | 'import';
  pendingTrade?: { market: string; side: 'LONG' | 'SHORT' };
}

export interface LinkAccountWizardState {
  exchange?: string;
  method?: 'generate' | 'import';
  privateKeyBase58?: string;
}

export interface TradeWizardState {
  exchange?: string;
  market?: string;
  side?: 'LONG' | 'SHORT';
  collateralUsd?: number;
  leverage?: number;
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface ClosePositionWizardState {
  exchange?: string;
  market?: string;
  percent?: number;
}

export interface SettingsWizardState {
  field?: 'leverage' | 'slippage' | 'orderType' | 'marginMode' | 'language' | 'timezone' | 'maxLeverage' | 'defaultCollateral';
}

export interface BroadcastWizardState {
  message?: string;
}

export interface WithdrawWizardState {
  source?: 'PHOENIX' | 'WALLET';
  amount?: number;
  destination?: string;
}

export interface FundPhoenixWizardState {
  amount?: number;
}

export type BotSession = Scenes.WizardSession<Scenes.WizardSessionData>;

export interface BotContext extends Context {
  scene: Scenes.SceneContextScene<BotContext, Scenes.WizardSessionData>;
  wizard: Scenes.WizardContextWizard<BotContext>;
  session: BotSession;
  /** Populated by auth middleware after resolving the Telegram sender to an internal user. */
  appUserId?: number;
}

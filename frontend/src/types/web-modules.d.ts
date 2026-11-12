declare module '@web/rig.js' {
  export function loadRig(id: string): unknown;
  export function drawRig(...args: unknown[]): void;
}

declare module '@web/sprite.js' {
  export function drawSprite(...args: unknown[]): void;
  export function ensureSprites(...args: unknown[]): unknown;
  export function spritesReady(id?: string): boolean;
  export function loadSpriteIndex(): Promise<unknown>;
}

declare module '@web/fx.js' {
  export function createFx(options: Record<string, unknown>): {
    reset(): void;
    ingest(events: unknown): void;
    observe(frame: unknown, events?: unknown): void;
    shake(frame: unknown): { x: number; y: number; amp: number };
    draw(...args: unknown[]): void;
  };
}

declare module '@web/impact-fx.js' {
  export function createImpactFx(options: Record<string, unknown>): {
    reset(): void;
    ingest(events: unknown): void;
    replace(events: unknown): void;
    draw(...args: unknown[]): void;
    windowTicks: number;
  };
}

declare module '@web/asset-store.js' {
  export function loadFighterArt(id: string, kind?: string): Promise<unknown>;
  export function loadStageArt(): Promise<unknown>;
  export function preloadFighters(ids: string[]): void;
  export function assetFor(id: string, kind: string): { path: string; width?: number; height?: number } | null;
  export function legacyArtUrl(id: string): string;
  export function loadManifest(): Promise<unknown>;
  export function manifestReady(): boolean;
  export function variantFor(id: string, kind: string): { path: string; width?: number; height?: number } | null;
}

declare module '@web/audio.js' {
  export function play(name: string): void;
  export function isEnabled(): boolean;
  export function setEnabled(value: boolean): void;
}

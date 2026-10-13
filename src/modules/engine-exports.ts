// Convenience re-export so feature modules import the engine primitives from one stable path.
export { execute, rec, checkSnapshot, loadItem, makeCtx, type CoreCtx, type OpMeta, type OpResult } from './transactions/engine.js';

// @ts-expect-error -- React reads this global to allow act() in tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

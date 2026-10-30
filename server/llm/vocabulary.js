// The words a generation is asked in. no imports, so the spec reads the same lists the routes check

// impersonate asks for the user's line and stores nothing; it streams into the composer as a draft
export const GENERATE_MODES = ['append', 'regenerate', 'swipe', 'continue', 'impersonate'];

// what a model call is for, as the routes and ctx.llm stamp it
export const LLM_PURPOSES = ['chat', 'assistant', 'creator', 'tool', 'test', 'extension'];

// 'append' is ST's 'normal'; the other modes share ST's trigger vocabulary as-is
export const triggerOfMode = (mode) => (mode === 'append' ? 'normal' : mode);

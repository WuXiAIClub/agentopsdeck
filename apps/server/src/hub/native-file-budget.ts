import {BOARD_MAX_BODY_BYTES, WORKSPACE_FILE_CARD_MAX_BYTES} from '@agentopsdeck/shared';

// A leaf module: command domains must not read one another's top-level values
// while HubStore/identity are still being initialized through another entry.
export const HUB_NATIVE_FILE_BYTES = Math.max(BOARD_MAX_BODY_BYTES, WORKSPACE_FILE_CARD_MAX_BYTES) + 65_536;

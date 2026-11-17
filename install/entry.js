// Entry of the standalone `monish` binary (install/build.sh, bun build --compile): the skill and the
// old Notification hook script are bundled as text, since the binary has no package folder to read.
'use strict';

globalThis.MONISH_STANDALONE = {
  skill: require('../skills/monish/SKILL.md'),
  hook: require('../hooks/notify.sh'),
};
require('../cli/monish.js');

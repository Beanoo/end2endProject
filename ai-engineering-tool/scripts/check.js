const { defaultTargetRepo } = require("../src/config");
const { getRepoStatus } = require("../src/git");

const status = getRepoStatus(defaultTargetRepo);
console.log(JSON.stringify(status, null, 2));


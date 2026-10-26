import assert from 'node:assert/strict';
import {hasVerifiedBearer,isAuthorizedRequest,assertSecureRuntimeConfiguration} from './httpAuth.js';
const before={token:process.env.MCP_BRIDGE_BEARER_TOKEN,required:process.env.MCP_BRIDGE_REQUIRE_BEARER};
try{
 process.env.MCP_BRIDGE_BEARER_TOKEN='fixture-only-bearer-0123456789abcdef';
 process.env.MCP_BRIDGE_REQUIRE_BEARER='0';
 assert.equal(isAuthorizedRequest(undefined),true);
 assert.equal(hasVerifiedBearer(undefined),false);
 assert.equal(hasVerifiedBearer('Bearer wrong'),false);
 assert.equal(hasVerifiedBearer('Bearer '+process.env.MCP_BRIDGE_BEARER_TOKEN),true);
 process.env.MCP_BRIDGE_REQUIRE_BEARER='1';
 assert.equal(isAuthorizedRequest(undefined),false);
 assert.equal(isAuthorizedRequest('Bearer '+process.env.MCP_BRIDGE_BEARER_TOKEN),true);
 assertSecureRuntimeConfiguration();
 process.env.MCP_BRIDGE_BEARER_TOKEN='weak';process.env.MCP_BRIDGE_REQUIRE_BEARER='0';
 assert.equal(hasVerifiedBearer('Bearer weak'),false);
 process.env.MCP_BRIDGE_REQUIRE_BEARER='1';assert.throws(assertSecureRuntimeConfiguration);
 console.log('httpAuth: required/optional verified bearer + weak-token denial PASS');
}finally{
 if(before.token===undefined)delete process.env.MCP_BRIDGE_BEARER_TOKEN;else process.env.MCP_BRIDGE_BEARER_TOKEN=before.token;
 if(before.required===undefined)delete process.env.MCP_BRIDGE_REQUIRE_BEARER;else process.env.MCP_BRIDGE_REQUIRE_BEARER=before.required;
}


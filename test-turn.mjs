/**
 * Definitive TURN server test for Codespaces.
 * Run with: node test-turn.mjs
 * 
 * Tests multiple TURN configurations to find what works.
 */

import net from 'net';
import dgram from 'dgram';

// Force debug output to stderr
process.env.DEBUG = process.env.DEBUG || 'werift-ice,werift:*,werift-ice:*,werift:ice:*';
process.env.DEBUG_COLORS = '0';
process.env.DEBUG_HIDE_DATE = 'true';

const TURN_HOST = 'openrelay.metered.ca';
const TURN_PORT = 443;
const TURN_USERNAME = 'openrelayproject';
const TURN_CREDENTIAL = 'openrelayproject';

// Import werift AFTER setting DEBUG
const { RTCPeerConnection } = await import('werift');

async function testTcpConnectivity() {
  console.log('\n=== Test 1: TCP Connectivity ===');
  return new Promise((resolve) => {
    const socket = net.connect(TURN_PORT, TURN_HOST, () => {
      console.log(`✅ TCP connection to ${TURN_HOST}:${TURN_PORT} SUCCEEDED`);
      socket.end();
      resolve(true);
    });
    socket.on('error', (err) => {
      console.log(`❌ TCP connection FAILED: ${err.message}`);
      resolve(false);
    });
    socket.setTimeout(5000, () => {
      console.log('❌ TCP connection TIMED OUT');
      socket.destroy();
      resolve(false);
    });
  });
}

async function testTurnAllocation(name, config) {
  console.log(`\n=== Test: ${name} ===`);
  console.log(`Config: ${JSON.stringify(config)}`);

  const pc = new RTCPeerConnection(config);

  const results = {
    candidates: [],
    hasRelay: false,
    errors: [],
    gatheringComplete: false,
  };

  return new Promise(async (resolve) => {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate;
        results.candidates.push(c);
        console.log(`  Candidate #${results.candidates.length}: ${c.candidate?.slice(0, 120)}`);
        if (c.candidate?.includes('typ relay')) {
          results.hasRelay = true;
          console.log('  ✅ RELAY CANDIDATE DETECTED!');
        }
      } else {
        results.gatheringComplete = true;
        console.log(`\n  ICE gathering complete. Total candidates: ${results.candidates.length}`);
      }
    };

    pc.onicecandidateerror = (event) => {
      results.errors.push(event);
      console.log(`  ❌ ICE ERROR: code=${event.errorCode} text="${event.errorText}" url="${event.url}"`);
    };

    pc.onicegatheringstatechange = () => {
      console.log(`  ICE gathering state: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`  ICE connection state: ${pc.iceConnectionState}`);
    };

    pc.addTransceiver('video', { direction: 'sendonly' });
    
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('  Offer created, ICE gathering started...');
    } catch (err) {
      console.log(`  ❌ Offer creation failed: ${err.message}`);
    }

    setTimeout(() => {
      console.log(`  Result: ${results.candidates.length} candidates, ${results.hasRelay ? 'HAS RELAY' : 'NO RELAY'}`);
      if (results.errors.length > 0) {
        console.log(`  Errors: ${results.errors.length}`);
      }
      pc.close();
      resolve(results);
    }, 20000); // 20 second timeout
  });
}

async function main() {
  console.log('========================================');
  console.log('TURN Server Test for GitHub Codespaces');
  console.log('========================================');
  console.log(`Time: ${new Date().toISOString()}`);

  const tcpOk = await testTcpConnectivity();
  if (!tcpOk) {
    console.log('\n❌ TCP connectivity failed - TURN cannot work');
    process.exit(1);
  }

  // Test 1: Default config (UDP, no turnTransport)
  const test1 = await testTurnAllocation('Default (UDP, no turnTransport)', {
    iceServers: [{
      urls: `turn:${TURN_HOST}:${TURN_PORT}`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    }],
  });

  // Test 2: TCP transport
  const test2 = await testTurnAllocation('TCP transport', {
    iceServers: [{
      urls: `turn:${TURN_HOST}:${TURN_PORT}`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    }],
    turnTransport: 'tcp',
  });

  // Test 3: URL with transport=tcp
  const test3 = await testTurnAllocation('URL with transport=tcp', {
    iceServers: [{
      urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    }],
  });

  // Test 4: TCP transport + URL with transport=tcp
  const test4 = await testTurnAllocation('TCP transport + URL transport=tcp', {
    iceServers: [{
      urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    }],
    turnTransport: 'tcp',
  });

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Test 1 (Default UDP): ${test1.hasRelay ? '✅ RELAY' : '❌ NO RELAY'} (${test1.candidates.length} candidates)`);
  console.log(`Test 2 (TCP transport): ${test2.hasRelay ? '✅ RELAY' : '❌ NO RELAY'} (${test2.candidates.length} candidates)`);
  console.log(`Test 3 (URL transport=tcp): ${test3.hasRelay ? '✅ RELAY' : '❌ NO RELAY'} (${test3.candidates.length} candidates)`);
  console.log(`Test 4 (TCP + URL): ${test4.hasRelay ? '✅ RELAY' : '❌ NO RELAY'} (${test4.candidates.length} candidates)`);

  const anyRelay = test1.hasRelay || test2.hasRelay || test3.hasRelay || test4.hasRelay;
  if (anyRelay) {
    console.log('\n✅ TURN CAN WORK from Codespaces - one of the configurations succeeded');
    process.exit(0);
  } else {
    console.log('\n❌ TURN DOES NOT WORK from Codespaces');
    console.log('All configurations failed to generate a relay candidate.');
    console.log('This is a Codespaces networking limitation.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

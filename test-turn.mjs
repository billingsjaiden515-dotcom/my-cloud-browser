/**
 * Definitive TURN server test for Codespaces.
 * Run with: DEBUG=werift-ice,werift:* node test-turn.mjs
 *
 * This script tests:
 * 1. TCP connectivity to TURN server
 * 2. TURN allocation using werift (same library as the app)
 * 3. Whether relay candidates are generated
 */

import { RTCPeerConnection } from 'werift';
import net from 'net';

const TURN_URL = 'turn:openrelay.metered.ca:443';
const TURN_USERNAME = 'openrelayproject';
const TURN_CREDENTIAL = 'openrelayproject';

// Enable werift debug logging if not already set
if (!process.env.DEBUG) {
  process.env.DEBUG = 'werift-ice,werift:*';
}

async function testTcpConnectivity() {
  console.log('\n=== Test 1: TCP Connectivity ===');
  return new Promise((resolve) => {
    const socket = net.connect(443, 'openrelay.metered.ca', () => {
      console.log(`✅ TCP connection to openrelay.metered.ca:443 SUCCEEDED`);
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

async function testTurnAllocation() {
  console.log('\n=== Test 2: TURN Allocation (werift) ===');
  console.log(`TURN URL: ${TURN_URL}`);
  console.log(`Username: ${TURN_USERNAME}`);

  const pc = new RTCPeerConnection({
    iceServers: [{
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    }],
    turnTransport: 'tcp',
  });

  const results = {
    candidates: [],
    hasRelay: false,
    errors: [],
    gatheringComplete: false,
  };

  return new Promise(async (resolve) => {
    // Collect all ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate;
        results.candidates.push(c);
        const isRelay = c.candidate?.includes('typ relay');
        console.log(`  Candidate #${results.candidates.length}: ${c.candidate?.slice(0, 100)}`);
        if (isRelay) {
          results.hasRelay = true;
          console.log('  ✅ RELAY CANDIDATE DETECTED!');
        }
      } else {
        // null candidate = gathering complete
        results.gatheringComplete = true;
        console.log(`\n  ICE gathering complete. Total candidates: ${results.candidates.length}`);
        console.log(`  Has relay candidate: ${results.hasRelay}`);
      }
    };

    pc.onicecandidateerror = (event) => {
      results.errors.push(event);
      console.log(`  ❌ ICE candidate error: code=${event.errorCode} text="${event.errorText}" url="${event.url}"`);
    };

    pc.onicegatheringstatechange = () => {
      console.log(`  ICE gathering state: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`  ICE connection state: ${pc.iceConnectionState}`);
    };

    // Create a transceiver and offer to trigger ICE gathering
    pc.addTransceiver('video', { direction: 'sendonly' });
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('  Offer created, ICE gathering started...');

    // Wait for gathering to complete or timeout
    setTimeout(() => {
      console.log('\n=== Results ===');
    if (results.hasRelay) {
        console.log('✅ TURN ALLOCATION SUCCEEDED - relay candidate generated');
      } else if (results.candidates.length === 0) {
        console.log('❌ NO CANDIDATES GENERATED - TURN allocation failed silently');
      } else {
        console.log(`❌ NO RELAY CANDIDATE - only ${results.candidates.length} host/srflx candidates`);
      }
      if (results.errors.length > 0) {
        console.log(`  ICE errors: ${results.errors.length}`);
      }
      console.log(`  Gathering complete: ${results.gatheringComplete}`);
      pc.close();
      resolve(results);
    }, 15000); // 15 second timeout
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

  const turnResults = await testTurnAllocation();

  console.log('\n========================================');
  console.log('CONCLUSION');
  console.log('========================================');
  if (turnResults.hasRelay) {
    console.log('✅ TURN WORKS from Codespaces');
    console.log('The problem is in the application code, not networking.');
    process.exit(0);
  } else {
    console.log('❌ TURN DOES NOT WORK from Codespaces');
    if (turnResults.candidates.length === 0) {
      console.log('No candidates at all - TURN allocation is failing completely.');
    } else {
      console.log('Only host/srflx candidates - TURN allocation is not completing.');
    }
    console.log('This is a Codespaces networking limitation or TURN server issue.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

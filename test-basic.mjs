// Basic test file to verify functionality
import { resolvePhoneFromLid } from './index.js';

// Mock socket with signalRepository
const mockSocket = {
  signalRepository: {
    lidMapping: {
      getPNForLID: (lid) => {
        if (lid === '123456@lid') return '51999999999@s.whatsapp.net';
        return null;
      }
    }
  }
};

// Test 1: @s.whatsapp.net contact
console.log('Test 1: @s.whatsapp.net contact');
const msg1 = {
  key: {
    remoteJid: '51999999999@s.whatsapp.net',
    fromMe: false,
    id: 'test1'
  },
  message: { conversation: 'Hola' }
};
console.log('Expected: 51999999999@s.whatsapp.net');
console.log('Result:', resolvePhoneFromLid({ key: { remoteJid: '51999999999@s.whatsapp.net', id: 'test1' } }));
console.log('---');

// Test 2: @lid with remoteJidAlt
console.log('Test 2: @lid with remoteJidAlt');
const msg2 = {
  key: {
    remoteJid: '123456@lid',
    remoteJidAlt: '51988888888@s.whatsapp.net',
    fromMe: false,
    id: 'test2'
  },
  message: { conversation: 'Hola' }
};
const mockSocket2 = { signalRepository: { lidMapping: { getPNForLID: () => null } } };
global.socket = { signalRepository: { lidMapping: { getPNForLID: () => null } } };
console.log('Expected: 51988888888@s.whatsapp.net');
console.log('Result:', resolvePhoneFromLid({ key: { remoteJid: '123456@lid', remoteJidAlt: '51988888888@s.whatsapp.net', id: 'test2' } }));
console.log('---');

// Test 3: LID resolved by map
console.log('Test 3: LID resolved by map');
const msg3 = {
  key: {
    remoteJid: '123456@lid',
    fromMe: false,
    id: 'test3'
  }
};
// Add to map
global.lidToPhoneJid = new Map();
global.lidToPhoneJid.set('123456@lid', '51977777777@s.whatsapp.net');
global.socket = { signalRepository: { lidMapping: { getPNForLID: () => null } } };
console.log('Expected: 51977777777@s.whatsapp.net');
console.log('Result:', resolvePhoneFromLid({ key: { remoteJid: '123456@lid', id: 'test3' } }));
console.log('---');

// Test 4: LID resolved by signalRepository
console.log('Test 4: LID resolved by signalRepository');
const msg4 = {
  key: {
    remoteJid: '999999@lid',
    fromMe: false,
    id: 'test4'
  }
};
global.socket = {
  signalRepository: {
    lidMapping: {
      getPNForLID: (lid) => {
        if (lid === '999999@lid') return '51966666666@s.whatsapp.net';
        return null;
      }
    }
  };
console.log('Expected: 51966666666@s.whatsapp.net');
console.log('Result:', resolvePhoneFromLid({ key: { remoteJid: '999999@lid', id: 'test4' } }));
console.log('---');

// Test 5: Unresolvable LID
console.log('Test 5: Unresolvable LID');
const msg5 = {
  key: {
    remoteJid: 'unresolvable@lid',
    fromMe: false,
    id: 'test5'
  }
};
global.socket = { signalRepository: { lidMapping: { getPNForLID: () => null } } };
global.lidToPhoneJid.clear();
console.log('Expected: null');
console.log('Result:', resolvePhoneFromLid({ key: { remoteJid: 'unresolvable@lid', id: 'test5' } }));
console.log('---');

console.log('All tests completed!');
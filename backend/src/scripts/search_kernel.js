const fs = require('fs');

const buf = fs.readFileSync('assets/flutter_assets/kernel_blob.bin');
console.log('Size of kernel_blob.bin:', buf.length);

function findString(query) {
  let idx = 0;
  const qBuf = Buffer.from(query, 'utf8');
  let count = 0;
  while ((idx = buf.indexOf(qBuf, idx)) !== -1) {
    count++;
    console.log(`\n=== MATCH #${count}: "${query}" at offset ${idx} ===`);
    const start = Math.max(0, idx - 400);
    const end = Math.min(buf.length, idx + 500);
    const slice = buf.slice(start, end);
    let cleaned = '';
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      if (b >= 32 && b <= 126) cleaned += String.fromCharCode(b);
      else if (b === 10 || b === 13) cleaned += '\n';
      else cleaned += '.';
    }
    console.log(cleaned);
    idx += qBuf.length;
    if (count >= 5) break;
  }
  if (count === 0) console.log(`No matches found for "${query}"`);
}

findString('Blockchain Proof');
findString('Not registered');
findString('txHash');
findString('explorerUrl');
findString('assetRegistered');

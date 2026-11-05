const fs = require('fs');
const buf = fs.readFileSync('assets/flutter_assets/kernel_blob.bin');

function search(term) {
  let idx = 0;
  const q = Buffer.from(term, 'utf8');
  while ((idx = buf.indexOf(q, idx)) !== -1) {
    console.log(`\n=== Found "${term}" at ${idx} ===`);
    const slice = buf.slice(Math.max(0, idx - 400), Math.min(buf.length, idx + 800));
    let cleaned = '';
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      if (b >= 32 && b <= 126) cleaned += String.fromCharCode(b);
      else if (b === 10 || b === 13) cleaned += '\n';
      else cleaned += '.';
    }
    console.log(cleaned);
    idx += q.length;
  }
}

search('Asset Details');
search('Not registered');
search('Blockchain Proof');

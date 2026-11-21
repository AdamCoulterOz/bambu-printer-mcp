#!/usr/bin/env python3
"""Read-only export evidence; no printer safety or semantic qualification implied."""
import hashlib,json,re,sys,zipfile
from pathlib import Path
p=Path(sys.argv[1]); size=p.stat().st_size
if not 0<size<=128*1024*1024: raise SystemExit('FAIL: export size')
with zipfile.ZipFile(p) as z:
 infos=z.infolist(); names=[i.filename for i in infos]
 if len(names)!=len(set(n.casefold() for n in names)): raise SystemExit('FAIL: duplicate or case-colliding ZIP names')
 if sum(i.file_size for i in infos)>512*1024*1024: raise SystemExit('FAIL: expanded archive limit')
 bad=z.testzip()
 if bad: raise SystemExit('FAIL: CRC '+bad)
 g=[i for i in infos if i.filename.lower().endswith('.gcode') and i.file_size>0]
 if not g: raise SystemExit('FAIL: no nonempty G-code')
 plate=[n for n in names if re.search(r'(^|/)plate[_-]?[0-9]',n,re.I)]
 meta=[n for n in names if 'metadata/' in n.lower() and (n.lower().endswith('.config') or n.lower().endswith('.json'))]
 headers={}
 for i in g:
  with z.open(i) as f: lines=f.read(65536).decode('utf-8','replace').splitlines()
  headers[i.filename]=[line[:500] for line in lines if re.search(r'printer_model|printer_settings_id|filament_type|filament_settings_id|plate|nozzle_diameter',line,re.I)][:30]
sha=hashlib.sha256(p.read_bytes()).hexdigest()
print(json.dumps({'bytes':size,'sha256':sha,'crc':'ok','gcode_members':[{'name':i.filename,'bytes':i.file_size} for i in g],'plate_named_members':plate,'metadata_members':meta,'selected_gcode_header_lines':headers},indent=2))

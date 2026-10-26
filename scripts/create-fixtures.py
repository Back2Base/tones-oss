"""Generate small synthetic acceptance inputs using only the Python standard library."""
from pathlib import Path
import json,textwrap,zipfile,html
out=Path(__file__).resolve().parents[1]/'.build'/'fixtures';out.mkdir(parents=True,exist_ok=True)
base='I want a clear answer before we discuss the details. We can review the small change together and decide what to do next. '
text=' '.join((base*100).split()[:2000])
(out/'sample.md').write_text(text)
(out/'unsupported.bin').write_bytes(b'unsupported synthetic fixture')
with zipfile.ZipFile(out/'sample.docx','w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+''.join('<w:p><w:r><w:t>'+html.escape(line)+'</w:t></w:r></w:p>' for line in textwrap.wrap(text,200))+'</w:body></w:document>')
# A conventional PDF with a built-in font, text streams, and an xref table.
lines=textwrap.wrap(text,90);pages=[lines[i:i+45] for i in range(0,len(lines),45)]
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
kids=[]
for page in pages:
 page_id=len(objects)+1;stream_id=page_id+1;kids.append(f'{page_id} 0 R')
 objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
 escaped=[s.replace('\\','\\\\').replace('(','\\(').replace(')','\\)') for s in page]
 stream=('BT /F1 10 Tf 40 750 Td 15 TL '+ ' T* '.join('('+s+') Tj' for s in escaped)+' ET').encode()
 objects.append(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream')
objects[1]=f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count {len(kids)} >>'.encode()
pdf=b'%PDF-1.4\n';offsets=[0]
for i,obj in enumerate(objects,1):
 offsets.append(len(pdf));pdf+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
xref=len(pdf);pdf+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()+b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets[1:])
pdf+=f'trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
(out/'sample.pdf').write_bytes(pdf)
print('Created synthetic MD/PDF/DOCX/unsupported fixtures, with 2000 words per supported sample')

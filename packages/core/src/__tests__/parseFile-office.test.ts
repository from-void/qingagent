import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseFileBuffer, parseFileTool } from "../tools/parseFile.js";

type ParseFileResult = {
  text: string;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
  };
};

async function executeParseFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ParseFileResult> {
  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  process.env.QINGAGENT_RUNTIME = "desktop";
  try {
    return (await parseFileTool.execute!(
      {
        content: buffer.toString("base64"),
        filename,
        mimeType,
      },
      {} as never,
    )) as ParseFileResult;
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
}

function createSyntheticZipDirectory(
  entries: Array<{ compressedBytes: number; uncompressedBytes: number }>,
  declaredEntryCount = entries.length,
): Buffer {
  const centralEntries = entries.map((entry, index) => {
    const filename = Buffer.from(`entry-${index}.xml`, "utf8");
    const header = Buffer.alloc(46 + filename.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(entry.compressedBytes, 20);
    header.writeUInt32LE(entry.uncompressedBytes, 24);
    header.writeUInt16LE(filename.length, 28);
    filename.copy(header, 46);
    return header;
  });
  const centralDirectory = Buffer.concat(centralEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(declaredEntryCount, 8);
  eocd.writeUInt16LE(declaredEntryCount, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}

async function createXlsxFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="一月" sheetId="1" r:id="rId1"/>
    <sheet name="二月" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>姓名</t></si>
  <si><t>数量</t></si>
  <si><t>苹果</t></si>
  <si><t>合计</t></si>
</sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>
  </sheetData>
</worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>二月项目</t></is></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>42</v></c></row>
  </sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createXlsxDisplayValuesFixture(options: { date1904?: boolean; dateSerial?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const date1904 = options.date1904 ?? false;
  const dateSerial = options.dateSerial ?? "45292";
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${date1904 ? '<workbookPr date1904="1"/>' : ""}
  <sheets><sheet name="Display" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Name</t></si>
  <si><t>Amount</t></si>
  <si><t>Date</t></si>
  <si><t>FormulaNoCache</t></si>
  <si><t>Tail</t></si>
  <si><t>合同A</t></si>
  <si><t>TAIL_AFTER_FORMULA</t></si>
</sst>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>5</v></c>
      <c r="B2" s="1"><v>1234.5</v></c>
      <c r="C2" s="2"><v>${dateSerial}</v></c>
      <c r="D2"><f>B2*3</f></c>
      <c r="E2" t="s"><v>6</v></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createXlsxRound7NumberFormatFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="NumberFormats" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
    <numFmt numFmtId="165" formatCode="[$-zh-CN]yyyy&quot;年&quot;m&quot;月&quot;d&quot;日"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="15" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="45" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="46" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="47" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="11" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="37" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Case</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Builtin14Date</t></is></c><c r="B2" s="1"><v>45292</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Builtin20Time</t></is></c><c r="B3" s="3"><v>0.5</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Builtin21Time</t></is></c><c r="B4" s="4"><v>0.5</v></c></row>
    <row r="5"><c r="A5" t="inlineStr"><is><t>Builtin45MmSs</t></is></c><c r="B5" s="6"><v>0.0104166666667</v></c></row>
    <row r="6"><c r="A6" t="inlineStr"><is><t>Builtin46Duration</t></is></c><c r="B6" s="7"><v>1.5</v></c></row>
    <row r="7"><c r="A7" t="inlineStr"><is><t>Builtin47Mmss0</t></is></c><c r="B7" s="8"><v>0.0104166666667</v></c></row>
    <row r="8"><c r="A8" t="inlineStr"><is><t>Scientific</t></is></c><c r="B8" s="9"><v>12300</v></c></row>
    <row r="9"><c r="A9" t="inlineStr"><is><t>Currency</t></is></c><c r="B9" s="10"><v>1234.5</v></c></row>
    <row r="10"><c r="A10" t="inlineStr"><is><t>Percent</t></is></c><c r="B10" s="11"><v>0.1234</v></c></row>
    <row r="11"><c r="A11" t="inlineStr"><is><t>NegativeAccounting</t></is></c><c r="B11" s="12"><v>-1234</v></c></row>
    <row r="12"><c r="A12" t="inlineStr"><is><t>LocaleDate</t></is></c><c r="B12" s="13"><v>45292</v></c></row>
    <row r="13"><c r="A13" t="inlineStr"><is><t>TextNumericDateStyle</t></is></c><c r="B13" s="1" t="inlineStr"><is><t>45292</t></is></c></row>
    <row r="14"><c r="A14" t="inlineStr"><is><t>InlineNumericTimeStyle</t></is></c><c r="B14" s="3" t="inlineStr"><is><t>0.5</t></is></c></row>
  </sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createXlsxWithoutReadableSheets(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Missing" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/missing.xml"/>
</Relationships>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createEmptyReadableXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Empty" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createXlsxVisibilityFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Visible" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
    <sheet name="VeryHidden" sheetId="3" state="veryHidden" r:id="rId3"/>
  </sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>MERGED_VISIBLE_TOKEN</t></is></c><c r="B1" t="inlineStr"><is><t>VISIBLE_KEEP_TOKEN</t></is></c></row>
    <row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>HIDDEN_ROW_TOKEN</t></is></c></row>
    <row r="3" zeroHeight="1"><c r="A3" t="inlineStr"><is><t>ZERO_HEIGHT_ROW_TOKEN</t></is></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>VISIBLE_TAIL_TOKEN</t></is></c></row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN_SHEET_TOKEN</t></is></c></row></sheetData>
</worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet3.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>VERY_HIDDEN_SHEET_TOKEN</t></is></c></row></sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createXlsxPhoneticFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Ruby" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si>
    <r><t>東京</t></r>
    <rPh sb="0" eb="2"><t>XLSXRPHNOISEROUND9</t></rPh>
    <phoneticPr fontId="1"/>
  </si>
  <si><r><t>正文</t></r><r><t>拼接</t></r></si>
</sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>InlineRph</t></is></c><c r="B2" t="inlineStr"><is><r><t>大阪</t></r><r><t>城</t></r><rPh sb="0" eb="2"><t>XLSXRPHINLINENOISEROUND10</t></rPh><phoneticPr fontId="1"/></is></c></row>
  </sheetData>
</worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createDocxAuxiliaryFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>DOCXBODYROUND9</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  zip.file(
    "word/header1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>DOCXHEADERROUND9</w:t></w:r></w:p>
</w:hdr>`,
  );
  zip.file(
    "word/footer1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>DOCXFOOTERROUND9</w:t></w:r></w:p>
</w:ftr>`,
  );
  zip.file(
    "word/footnotes.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1"><w:p><w:r><w:t>DOCXFOOTNOTEROUND9</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
  );
  zip.file(
    "word/endnotes.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="1"><w:p><w:r><w:t>DOCXENDNOTEROUND9</w:t></w:r></w:p></w:endnote>
</w:endnotes>`,
  );
  zip.file(
    "word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1"><w:p><w:r><w:t>DOCXCOMMENTBUFFEREDROUND9</w:t></w:r></w:p></w:comment>
</w:comments>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPptxFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>第一页标题</a:t></a:r></a:p>
      <a:p><a:r><a:t>要点</a:t></a:r><a:r><a:t>一</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  zip.file(
    "ppt/slides/slide2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>第二页标题</a:t></a:r></a:p>
      <a:p><a:r><a:t>结论</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPptxPresentationOrderFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId1"/>
  </p:sldIdLst>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPT_ORDER_SECOND_TOKEN</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
  );
  zip.file(
    "ppt/slides/slide2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPT_ORDER_FIRST_TOKEN</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPptxNotesFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPTXSLIDEBODYROUND9</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  <Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPTXNOTESROUND9</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`,
  );
  zip.file(
    "ppt/charts/chart1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>PPTXCHARTBUFFEREDROUND9</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart>
</c:chartSpace>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPptxVisualOrderFixture(options: { withCoordinates: boolean }): Promise<Buffer> {
  const zip = new JSZip();
  const rightPosition = options.withCoordinates
    ? `<p:spPr><a:xfrm><a:off x="3000000" y="1000000"/></a:xfrm></p:spPr>`
    : "";
  const leftPosition = options.withCoordinates
    ? `<p:spPr><a:xfrm><a:off x="100000" y="1000000"/></a:xfrm></p:spPr>`
    : "";
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr/><p:spPr/>${rightPosition}
      <p:txBody><a:p><a:r><a:t>PPTX_RIGHT_XML_FIRST</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr/><p:spPr/>${leftPosition}
      <p:txBody><a:p><a:r><a:t>PPTX_LEFT_VISUAL_FIRST</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPptxWithZeroByteSlide(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", Buffer.alloc(0));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createEmptyReadablePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree/></p:cSld>
</p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function createBlankPdfFixture(): Buffer {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
    "utf8",
  );
}

describe("parseFile Office 文本解析", () => {
  it.each(["pdf", "docx"])("%s 解析在开始前响应父取消信号", async (ext) => {
    const reason = new DOMException("用户取消文件解析", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      parseFileBuffer({
        buffer: Buffer.from("not parsed"),
        filename: `cancelled.${ext}`,
        mimeType:
          ext === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("解压前拒绝高压缩比 Office ZIP，不进入 entry 解压", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", Buffer.alloc(2 * 1024 * 1024, 0x41));
    const bomb = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });

    const result = await parseFileBuffer({
      buffer: bomb,
      filename: "ratio-bomb.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected compression-ratio rejection");
    expect(result.error).toContain("Office ZIP 安全校验失败");
    expect(result.error).toContain("压缩比");
  });

  it("解压前拒绝超量 ZIP 条目和伪造的超大总解压量", async () => {
    const tooManyEntries = createSyntheticZipDirectory([], 10_001);
    const oversizedTotal = createSyntheticZipDirectory([
      { compressedBytes: 48 * 1024 * 1024, uncompressedBytes: 48 * 1024 * 1024 },
      { compressedBytes: 48 * 1024 * 1024, uncompressedBytes: 48 * 1024 * 1024 },
      { compressedBytes: 48 * 1024 * 1024, uncompressedBytes: 48 * 1024 * 1024 },
    ]);

    const [entryResult, totalResult] = await Promise.all([
      parseFileBuffer({
        buffer: tooManyEntries,
        filename: "entry-bomb.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      parseFileBuffer({
        buffer: oversizedTotal,
        filename: "size-bomb.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ]);

    expect(entryResult.ok).toBe(false);
    expect(totalResult.ok).toBe(false);
    if (entryResult.ok || totalResult.ok) throw new Error("expected ZIP directory limit rejection");
    expect(entryResult.error).toContain("条目数超过上限");
    expect(totalResult.error).toContain("总解压量超过");
  });

  it("parseFileBuffer 对脏文本不做 JSON 解析或截断", async () => {
    const dirty = [
      "前导说明",
      "```json",
      "{\"title\":\"A \\\"quoted\\\" value\",\"items\":[\"含 ] 和 } 的正文\"]}",
      "```",
      "尾随收尾散文 ] }",
    ].join("\n");
    const result = await parseFileBuffer({
      buffer: Buffer.from(dirty),
      filename: "dirty.md",
      mimeType: "text/markdown",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe(dirty);
    expect(result.metadata.wordCount).toBeGreaterThan(0);
  });

  it("parseFileBuffer 对伪 xlsx 脏输入返回结构化失败而不是正文", async () => {
    const result = await parseFileBuffer({
      buffer: Buffer.from("not a zip with trailing prose } ]"),
      filename: "broken.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected parse failure");
    expect(result.text).toBe("");
    expect(result.error).toContain("[Error] Failed to parse Excel file");
    expect(result.metadata.pages).toBeNull();
    expect(result.metadata.indexable).toBe(false);
  });

  it("parseFileBuffer 文本入口处理 BOM/UTF-16 并拒绝二进制伪装", async () => {
    const utf8Bom = await parseFileBuffer({
      buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("UTF8_BOM_TOKEN 中文\n", "utf8")]),
      filename: "bom.txt",
      mimeType: "text/plain",
    });
    const utf16le = await parseFileBuffer({
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("UTF16_TOKEN 中文\n", "utf16le")]),
      filename: "utf16.txt",
      mimeType: "text/plain",
    });
    const binary = await parseFileBuffer({
      buffer: Buffer.from("BINARY_ASCII_TOKEN\u0000after", "utf8"),
      filename: "binary.txt",
      mimeType: "text/plain",
    });

    expect(utf8Bom.ok).toBe(true);
    expect(utf8Bom.text).toBe("UTF8_BOM_TOKEN 中文\n");
    expect(utf16le.ok).toBe(true);
    expect(utf16le.text).toContain("UTF16_TOKEN 中文");
    expect(binary.ok).toBe(false);
    if (binary.ok) throw new Error("expected binary text failure");
    expect(binary.error).toContain("Failed to parse text file");
  });

  it("parseFileBuffer 拒绝 4KB 后的 NUL，但不误伤合法 UTF-16 BOM 文本", async () => {
    const lateNul = await parseFileBuffer({
      buffer: Buffer.concat([
        Buffer.from("LATE_NUL_PREFIX_", "utf8"),
        Buffer.alloc(5000, 0x61),
        Buffer.from("\u0000LATE_NUL_AFTER", "utf8"),
      ]),
      filename: "late-nul.txt",
      mimeType: "text/plain",
    });
    const utf16le = await parseFileBuffer({
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("UTF16LE_VALID_TOKEN 中文", "utf16le")]),
      filename: "utf16le-valid.txt",
      mimeType: "text/plain",
    });
    const utf16be = await parseFileBuffer({
      buffer: Buffer.from([
        0xfe, 0xff,
        0x00, 0x55, 0x00, 0x54, 0x00, 0x46, 0x00, 0x31, 0x00, 0x36, 0x00, 0x42, 0x00, 0x45,
      ]),
      filename: "utf16be-valid.txt",
      mimeType: "text/plain",
    });

    expect(lateNul.ok).toBe(false);
    if (lateNul.ok) throw new Error("expected late NUL failure");
    expect(lateNul.error).toContain("二进制控制字符");
    expect(utf16le.ok).toBe(true);
    expect(utf16le.text).toContain("UTF16LE_VALID_TOKEN 中文");
    expect(utf16be.ok).toBe(true);
    expect(utf16be.text).toContain("UTF16BE");
  });

  it("parseFileBuffer 拒绝 BOM 后 payload 字节数为奇数的 UTF-16 文本", async () => {
    const utf16leTruncated = await parseFileBuffer({
      buffer: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("UTF16LE_TRUNCATED_TOKEN", "utf16le"),
        Buffer.from([0x4e]),
      ]),
      filename: "utf16le-truncated.txt",
      mimeType: "text/plain",
    });
    const utf16beTruncated = await parseFileBuffer({
      buffer: Buffer.from([
        0xfe, 0xff,
        0x00, 0x55, 0x00, 0x54, 0x00, 0x46, 0x00, 0x31, 0x00, 0x36, 0x00, 0x42, 0x00, 0x45,
        0x4e,
      ]),
      filename: "utf16be-truncated.txt",
      mimeType: "text/plain",
    });

    expect(utf16leTruncated.ok).toBe(false);
    if (utf16leTruncated.ok) throw new Error("expected truncated UTF-16LE failure");
    expect(utf16leTruncated.error).toContain("UTF-16");
    expect(utf16beTruncated.ok).toBe(false);
    if (utf16beTruncated.ok) throw new Error("expected truncated UTF-16BE failure");
    expect(utf16beTruncated.error).toContain("UTF-16");
  });

  it("parseFileBuffer 拒绝稀疏非法字节解码出的替换字符噪声", async () => {
    const result = await parseFileBuffer({
      buffer: Buffer.concat([
        Buffer.from([0xc3, 0x28]),
        Buffer.from("MIXED_SUFFIX_".repeat(80), "utf8"),
      ]),
      filename: "mixed-low-invalid.txt",
      mimeType: "text/plain",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid text failure");
    expect(result.text).toBe("");
    expect(result.error).toContain("替换字符");
  });

  it("PDF 损坏文件不抛出并返回清晰错误", async () => {
    const parsed = await parseFileBuffer({
      buffer: Buffer.from("not a pdf", "utf-8"),
      filename: "broken.pdf",
      mimeType: "application/pdf",
    });
    const result = await executeParseFile(
      Buffer.from("not a pdf", "utf-8"),
      "broken.pdf",
      "application/pdf",
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected broken pdf failure");
    expect(parsed.failureKind).toBe("error");
    expect(parsed.error).toContain("[Error] Failed to parse PDF file");
    expect(result.text).toContain("[Error] Failed to parse PDF file");
    expect(result.metadata.pages).toBeNull();
  });

  it("DOCX 损坏文件不抛出并返回清晰错误", async () => {
    const parsed = await parseFileBuffer({
      buffer: Buffer.from("not a docx", "utf-8"),
      filename: "broken.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const result = await executeParseFile(
      Buffer.from("not a docx", "utf-8"),
      "broken.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected broken docx failure");
    expect(parsed.failureKind).toBe("error");
    expect(parsed.error).toContain("[Error] Failed to parse DOCX file");
    expect(result.text).toContain("[Error] Failed to parse DOCX file");
    expect(result.metadata.pages).toBeNull();
  });

  it("DOCX 追加页眉页脚脚注尾注，批注本轮不纳入正文", async () => {
    const result = await parseFileBuffer({
      buffer: await createDocxAuxiliaryFixture(),
      filename: "auxiliary.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("DOCXBODYROUND9");
    expect(result.text).toContain("DOCXHEADERROUND9");
    expect(result.text).toContain("DOCXFOOTERROUND9");
    expect(result.text).toContain("DOCXFOOTNOTEROUND9");
    expect(result.text).toContain("DOCXENDNOTEROUND9");
    expect(result.text).not.toContain("DOCXCOMMENTBUFFEREDROUND9");
  });

  it("解析 xlsx 多 sheet 文本并记录 sheet 数", async () => {
    const result = await executeParseFile(
      await createXlsxFixture(),
      "sales.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    expect(result.text).toContain("# Sheet: 一月");
    expect(result.text).toContain("姓名\t数量");
    expect(result.text).toContain("苹果\t3");
    expect(result.text).toContain("# Sheet: 二月");
    expect(result.text).toContain("二月项目\t数量");
    expect(result.text).toContain("合计\t42");
    expect(result.metadata.pages).toBe(2);
    expect(result.metadata.wordCount).toBeGreaterThan(0);
  });

  it("xlsx sharedString 与 inlineStr 都排除 rPh 拼音标注但保留普通富文本 runs", async () => {
    const result = await parseFileBuffer({
      buffer: await createXlsxPhoneticFixture(),
      filename: "phonetic.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("東京\t正文拼接");
    expect(result.text).toContain("InlineRph\t大阪城");
    expect(result.text).not.toContain("XLSXRPHNOISEROUND9");
    expect(result.text).not.toContain("XLSXRPHINLINENOISEROUND10");
  });

  it("xlsx 按样式输出日期显示值并保留无缓存公式文本", async () => {
    const result = await parseFileBuffer({
      buffer: await createXlsxDisplayValuesFixture(),
      filename: "display-values.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("合同A\t1,234.50\t2024-01-01\t=B2*3\tTAIL_AFTER_FORMULA");
    expect(result.text).not.toContain("2469\t\tTAIL_AFTER_FORMULA");
  });

  it("xlsx 支持 1904 日期系统", async () => {
    const result = await parseFileBuffer({
      buffer: await createXlsxDisplayValuesFixture({ date1904: true, dateSerial: "0" }),
      filename: "date1904.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("1904-01-01");
  });

  it("xlsx 区分日期、纯时间、累计时长并保留常见数字 numFmt", async () => {
    const result = await parseFileBuffer({
      buffer: await createXlsxRound7NumberFormatFixture(),
      filename: "round7-number-formats.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("Builtin14Date\t2024-01-01");
    expect(result.text).toContain("Builtin20Time\t12:00:00");
    expect(result.text).toContain("Builtin21Time\t12:00:00");
    expect(result.text).toContain("Builtin45MmSs\t15:00");
    expect(result.text).toContain("Builtin46Duration\t36:00:00");
    expect(result.text).toContain("Builtin47Mmss0\t1500.0");
    expect(result.text).not.toMatch(/Builtin(?:20Time|21Time|45MmSs|47Mmss0)\t(?:1899|1900)-/);
    expect(result.text).toContain("Scientific\t1.23E+04");
    expect(result.text).toContain("Currency\t$1,234.50");
    expect(result.text).toContain("Percent\t12.34%");
    expect(result.text).toContain("NegativeAccounting\t(1,234)");
    expect(result.text).toContain("LocaleDate\t2024-01-01");
    expect(result.text).toContain("TextNumericDateStyle\t45292");
    expect(result.text).toContain("InlineNumericTimeStyle\t0.5");
  });

  it("xlsx 无可读 worksheet 失败，但可读空 worksheet 仍是合法空内容", async () => {
    const broken = await parseFileBuffer({
      buffer: await createXlsxWithoutReadableSheets(),
      filename: "missing-all-sheets.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const empty = await parseFileBuffer({
      buffer: await createEmptyReadableXlsx(),
      filename: "empty-readable.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("expected broken xlsx failure");
    expect(broken.error).toContain("缺少可读工作表内容");
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("# Sheet: Empty");
    expect(empty.metadata.pages).toBe(1);
  });

  it("xlsx 跳过 hidden/veryHidden sheet 与 hidden/zeroHeight 行，合并单元格可见文本不受影响", async () => {
    const result = await parseFileBuffer({
      buffer: await createXlsxVisibilityFixture(),
      filename: "visibility.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("# Sheet: Visible");
    expect(result.text).toContain("MERGED_VISIBLE_TOKEN");
    expect(result.text).toContain("VISIBLE_KEEP_TOKEN");
    expect(result.text).toContain("VISIBLE_TAIL_TOKEN");
    expect(result.text).not.toContain("HIDDEN_ROW_TOKEN");
    expect(result.text).not.toContain("ZERO_HEIGHT_ROW_TOKEN");
    expect(result.text).not.toContain("HIDDEN_SHEET_TOKEN");
    expect(result.text).not.toContain("VERY_HIDDEN_SHEET_TOKEN");
    expect(result.metadata.pages).toBe(1);
  });

  it("Excel 分支能正确处理 csv 纯文本", async () => {
    const result = await executeParseFile(
      Buffer.from("姓名,数量\n苹果,3\n", "utf-8"),
      "sales.csv",
      "text/csv",
    );

    expect(result.text).toBe("姓名,数量\n苹果,3\n");
    expect(result.metadata.pages).toBe(1);
  });

  it("Excel 分支能 fallback 解码 GBK/GB18030 中文 CSV", async () => {
    const gbkCsv = Buffer.from([
      0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xca, 0xfd, 0xc1, 0xbf, 0x0a,
      0xc6, 0xbb, 0xb9, 0xfb, 0x2c, 0x33, 0x0a,
    ]);
    const result = await parseFileBuffer({
      buffer: gbkCsv,
      filename: "gbk-sales.csv",
      mimeType: "text/csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toBe("姓名,数量\n苹果,3\n");
    expect(result.metadata.wordCount).toBe("姓名,数量苹果,3".length);
  });

  it("Excel 空文件和损坏文件在上传工具中返回兼容错误文本", async () => {
    const empty = await executeParseFile(
      Buffer.alloc(0),
      "empty.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const broken = await executeParseFile(
      Buffer.from("not a zip archive", "utf-8"),
      "broken.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    expect(empty.text).toContain("[Error] Failed to parse Excel file");
    expect(empty.metadata.pages).toBeNull();
    expect(broken.text).toContain("[Error] Failed to parse Excel file");
  });

  it("旧版 xls 二进制返回友好提示", async () => {
    const buffer = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]);
    const parsed = await parseFileBuffer({
      buffer,
      filename: "legacy.xls",
      mimeType: "application/vnd.ms-excel",
    });
    const result = await executeParseFile(
      buffer,
      "legacy.xls",
      "application/vnd.ms-excel",
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected legacy xls unsupported failure");
    expect(parsed.failureKind).toBe("unsupported");
    expect(parsed.error).toContain("[Unsupported]");
    expect(parsed.error).toContain("旧版 .xls 二进制格式暂不支持解析");
    expect(result.text).toContain("旧版 .xls 二进制格式暂不支持解析");
    expect(result.metadata.pages).toBeNull();
  });

  it("解析 pptx 多页文本并记录幻灯片数", async () => {
    const result = await executeParseFile(
      await createPptxFixture(),
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    expect(result.text).toContain("# Slide 1");
    expect(result.text).toContain("第一页标题");
    expect(result.text).toContain("要点一");
    expect(result.text).toContain("# Slide 2");
    expect(result.text).toContain("第二页标题");
    expect(result.text).toContain("结论");
    expect(result.metadata.pages).toBe(2);
  });

  it("pptx 按 presentation.xml 的放映顺序提取文本", async () => {
    const result = await parseFileBuffer({
      buffer: await createPptxPresentationOrderFixture(),
      filename: "presentation-order.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text.indexOf("PPT_ORDER_FIRST_TOKEN")).toBeLessThan(
      result.text.indexOf("PPT_ORDER_SECOND_TOKEN"),
    );
    expect(result.metadata.pages).toBe(2);
  });

  it("pptx 沿 slide rels 追加演讲者备注，但不读取 chart 文本", async () => {
    const result = await parseFileBuffer({
      buffer: await createPptxNotesFixture(),
      filename: "notes.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toContain("PPTXSLIDEBODYROUND9");
    expect(result.text).toContain("PPTXNOTESROUND9");
    expect(result.text).not.toContain("PPTXCHARTBUFFEREDROUND9");
  });

  it("pptx 同一行形状按视觉坐标从左到右输出", async () => {
    const result = await parseFileBuffer({
      buffer: await createPptxVisualOrderFixture({ withCoordinates: true }),
      filename: "visual-order.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text.indexOf("PPTX_LEFT_VISUAL_FIRST")).toBeLessThan(
      result.text.indexOf("PPTX_RIGHT_XML_FIRST"),
    );
  });

  it("pptx 形状无坐标时退回 XML 顺序", async () => {
    const result = await parseFileBuffer({
      buffer: await createPptxVisualOrderFixture({ withCoordinates: false }),
      filename: "xml-order.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text.indexOf("PPTX_RIGHT_XML_FIRST")).toBeLessThan(
      result.text.indexOf("PPTX_LEFT_VISUAL_FIRST"),
    );
  });

  it("pptx 无可读 slide 失败，但可读空 slide 仍是合法空内容", async () => {
    const broken = await parseFileBuffer({
      buffer: await createPptxWithZeroByteSlide(),
      filename: "zero-slide.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const empty = await parseFileBuffer({
      buffer: await createEmptyReadablePptx(),
      filename: "empty-readable.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("expected broken pptx failure");
    expect(broken.error).toContain("缺少可读幻灯片内容");
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("# Slide 1");
    expect(empty.metadata.pages).toBe(1);
  });

  it("无文本层 PDF 去除页码噪声后不可索引且 wordCount 为 0", async () => {
    const result = await parseFileBuffer({
      buffer: createBlankPdfFixture(),
      filename: "blank.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toBe("");
    expect(result.metadata.pages).toBe(1);
    expect(result.metadata.wordCount).toBe(0);
    expect(result.metadata.indexable).toBe(false);
  });

  it("PPT 空文件和损坏文件在上传工具中返回兼容错误文本", async () => {
    const empty = await executeParseFile(
      Buffer.alloc(0),
      "empty.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    const broken = await executeParseFile(
      Buffer.from("not a zip archive", "utf-8"),
      "broken.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    expect(empty.text).toContain("[Error] Failed to parse PPT file");
    expect(empty.metadata.pages).toBeNull();
    expect(broken.text).toContain("[Error] Failed to parse PPT file");
  });

  it("旧版 ppt 二进制返回友好提示", async () => {
    const buffer = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]);
    const parsed = await parseFileBuffer({
      buffer,
      filename: "legacy.ppt",
      mimeType: "application/vnd.ms-powerpoint",
    });
    const result = await executeParseFile(
      buffer,
      "legacy.ppt",
      "application/vnd.ms-powerpoint",
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected legacy ppt unsupported failure");
    expect(parsed.failureKind).toBe("unsupported");
    expect(parsed.error).toContain("[Unsupported]");
    expect(parsed.error).toContain("旧版 .ppt 二进制格式暂不支持解析");
    expect(result.text).toContain("旧版 .ppt 二进制格式暂不支持解析");
    expect(result.metadata.pages).toBeNull();
  });
});

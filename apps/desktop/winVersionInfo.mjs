import { createHash } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const DEFAULT_LANGUAGE = Object.freeze({ lang: 0x0409, codepage: 1200 });
const DEFAULT_ICON_GROUP_ID = 32512;
const DEFAULT_ICON_PATH = new URL("./resources/icon.ico", import.meta.url);
const VERSION_FIELDS = Object.freeze([
  "ProductName",
  "FileDescription",
  "CompanyName",
  "LegalCopyright",
  "FileVersion",
  "ProductVersion",
]);

export const WIN_VERSION_STRINGS = Object.freeze({
  ProductName: "青简",
  FileDescription: "青简",
  CompanyName: "qingagent",
  LegalCopyright: "Copyright © 2026 qingagent",
});

export function parsePackageVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`桌面客户端版本号不是合法 SemVer: ${version}`);

  const numeric = [match[1], match[2], match[3], "0"].map(Number);
  if (numeric.some((part) => part > 0xffff)) {
    throw new Error(`桌面客户端版本号超出 Windows VersionInfo 范围: ${version}`);
  }
  return { text: version, numeric };
}

export async function readDesktopVersion() {
  const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  return parsePackageVersion(packageJson.version);
}

function uniqueLanguages(versionInfo) {
  const languages = [
    ...versionInfo.getAllLanguagesForStringValues(),
    ...versionInfo.getAvailableLanguages(),
  ];
  const unique = [];
  for (const language of languages) {
    if (!unique.some((item) => item.lang === language.lang && item.codepage === language.codepage)) {
      unique.push(language);
    }
  }
  return unique.length > 0 ? unique : [DEFAULT_LANGUAGE];
}

function numericVersion(ms, ls) {
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
}

function parseVersionInfo(binary) {
  const executable = NtExecutable.from(binary);
  const resources = NtExecutableResource.from(executable);
  return {
    executable,
    resources,
    versionInfo: Resource.VersionInfo.fromEntries(resources.entries),
  };
}

function readIconGroups(resources) {
  return Resource.IconGroupEntry.fromEntries(resources.entries).map((group) => {
    const embeddedIcons = group.getIconItemsFromEntries(resources.entries);
    return {
      id: group.id,
      lang: group.lang,
      icons: group.icons.map((icon) => ({ ...icon })),
      embeddedIconCount: embeddedIcons.length,
      iconDigests: embeddedIcons.map(iconDigest),
    };
  });
}

function iconDigest(icon) {
  const binary = icon.isIcon() ? icon.generate() : icon.bin;
  return createHash("sha256").update(Buffer.from(binary)).digest("hex");
}

export async function readWinVersionInfo(executablePath) {
  const { versionInfo } = parseVersionInfo(await readFile(executablePath));
  return versionInfo.map((info) => ({
    resourceLanguage: info.lang,
    fixedFileVersion: numericVersion(info.fixedInfo.fileVersionMS, info.fixedInfo.fileVersionLS),
    fixedProductVersion: numericVersion(info.fixedInfo.productVersionMS, info.fixedInfo.productVersionLS),
    strings: uniqueLanguages(info).map((language) => ({
      language,
      values: info.getStringValues(language),
    })),
  }));
}

export async function readWinIconInfo(executablePath) {
  const { resources } = parseVersionInfo(await readFile(executablePath));
  return readIconGroups(resources);
}

export function assertWinIconInfo(groups, expectedIconDigests) {
  if (groups.length === 0) throw new Error("exe 中没有图标组资源");

  for (const [groupIndex, group] of groups.entries()) {
    if (group.icons.length === 0) {
      throw new Error(`图标组[${groupIndex}](${group.id}/${group.lang}) 没有图标`);
    }
    if (group.embeddedIconCount !== group.icons.length) {
      throw new Error(
        `图标组[${groupIndex}](${group.id}/${group.lang}) 声明 ${group.icons.length} 个图标，` +
          `实际只读回 ${group.embeddedIconCount} 个`,
      );
    }
    if (expectedIconDigests !== undefined && group.icons.length !== expectedIconDigests.length) {
      throw new Error(
        `图标组[${groupIndex}](${group.id}/${group.lang}) 应有 ${expectedIconDigests.length} 个图标，` +
          `实际为 ${group.icons.length} 个`,
      );
    }
    if (
      expectedIconDigests !== undefined &&
      group.iconDigests.some((digest, iconIndex) => digest !== expectedIconDigests[iconIndex])
    ) {
      throw new Error(`图标组[${groupIndex}](${group.id}/${group.lang}) 不是 resources/icon.ico 的内容`);
    }
  }
  return groups;
}

export function assertWinVersionInfo(entries, version, expectedStrings = WIN_VERSION_STRINGS) {
  if (entries.length === 0) throw new Error("exe 中没有 VersionInfo 资源");

  const expectedNumeric = version.numeric.join(".");
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.fixedFileVersion.join(".") !== expectedNumeric) {
      throw new Error(`VersionInfo[${entryIndex}] 的固定 FileVersion 不是 ${expectedNumeric}`);
    }
    if (entry.fixedProductVersion.join(".") !== expectedNumeric) {
      throw new Error(`VersionInfo[${entryIndex}] 的固定 ProductVersion 不是 ${expectedNumeric}`);
    }
    if (entry.strings.length === 0) throw new Error(`VersionInfo[${entryIndex}] 没有字符串表`);

    for (const { language, values } of entry.strings) {
      const expected = {
        ...expectedStrings,
        FileVersion: version.text,
        ProductVersion: version.text,
      };
      for (const field of VERSION_FIELDS) {
        if (values[field] !== expected[field]) {
          throw new Error(
            `VersionInfo[${entryIndex}](${language.lang}/${language.codepage}) 的 ${field}` +
              ` 应为 ${expected[field]}，实际为 ${values[field] ?? "<缺失>"}`,
          );
        }
      }
    }
  }
  return entries;
}

export async function verifyWinVersionInfo(executablePath, options = {}) {
  const version = options.version ?? (await readDesktopVersion());
  const expectedStrings = options.expectedStrings ?? WIN_VERSION_STRINGS;
  const entries = await readWinVersionInfo(executablePath);
  return assertWinVersionInfo(entries, version, expectedStrings);
}

export async function verifyWinIconInfo(executablePath, options = {}) {
  const iconPath = options.iconPath ?? DEFAULT_ICON_PATH;
  const iconFile = Data.IconFile.from(await readFile(iconPath));
  if (iconFile.icons.length === 0) throw new Error("icon.ico 中没有图标");
  const groups = await readWinIconInfo(executablePath);
  return assertWinIconInfo(groups, iconFile.icons.map((icon) => iconDigest(icon.data)));
}

export async function stampWinVersionInfo(executablePath, options = {}) {
  const version = options.version ?? (await readDesktopVersion());
  const versionStrings = options.versionStrings ?? WIN_VERSION_STRINGS;
  const iconPath = options.iconPath ?? DEFAULT_ICON_PATH;
  const [source, iconSource] = await Promise.all([
    readFile(executablePath),
    readFile(iconPath),
  ]);
  const iconFile = Data.IconFile.from(iconSource);
  if (iconFile.icons.length === 0) throw new Error("icon.ico 中没有图标");
  const sourceStat = await stat(executablePath);
  const { executable, resources, versionInfo } = parseVersionInfo(source);
  const infos = versionInfo.length > 0 ? versionInfo : [Resource.VersionInfo.createEmpty()];

  for (const info of infos) {
    const languages = uniqueLanguages(info);
    const primaryLanguage = languages[0];
    const [major, minor, micro, revision] = version.numeric;
    info.setFileVersion(major, minor, micro, revision, primaryLanguage.lang);
    info.setProductVersion(major, minor, micro, revision, primaryLanguage.lang);
    for (const language of languages) {
      info.setStringValues(language, {
        ...versionStrings,
        FileVersion: version.text,
        ProductVersion: version.text,
      });
    }
    info.outputToResourceEntries(resources.entries);
  }

  const existingIconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const iconTargets = existingIconGroups.length > 0
    ? existingIconGroups.map((group) => ({ id: group.id, lang: group.lang }))
    : [{ id: DEFAULT_ICON_GROUP_ID, lang: DEFAULT_LANGUAGE.lang }];
  for (const { id, lang } of iconTargets) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      id,
      lang,
      iconFile.icons.map((icon) => icon.data),
    );
  }

  resources.outputResource(executable);
  const temporaryPath = `${executablePath}.version-stamp-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, Buffer.from(executable.generate()), { mode: sourceStat.mode });
    await chmod(temporaryPath, sourceStat.mode);
    await rename(temporaryPath, executablePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  const entries = await verifyWinVersionInfo(executablePath, {
    version,
    expectedStrings: versionStrings,
  });
  await verifyWinIconInfo(executablePath, { iconPath });
  return entries;
}

function printVerified(executablePath, entries, iconGroups) {
  const first = entries[0];
  const values = first.strings[0].values;
  console.log(`    ✓ ${executablePath} VersionInfo 校验通过`);
  console.log(
    JSON.stringify(
      {
        ProductName: values.ProductName,
        FileDescription: values.FileDescription,
        CompanyName: values.CompanyName,
        LegalCopyright: values.LegalCopyright,
        FileVersion: values.FileVersion,
        ProductVersion: values.ProductVersion,
        FixedFileVersion: first.fixedFileVersion.join("."),
        FixedProductVersion: first.fixedProductVersion.join("."),
      },
      null,
      2,
    ),
  );
  console.log(
    `    ✓ ${executablePath} 图标资源校验通过` +
      `(${iconGroups.length} 组，每组 ${iconGroups[0].icons.length} 个尺寸)`,
  );
}

async function main() {
  const [command, executableArgument] = process.argv.slice(2);
  if (!executableArgument || !["stamp", "verify"].includes(command)) {
    throw new Error("用法: node winVersionInfo.mjs <stamp|verify> <exe 路径>");
  }
  const executablePath = resolve(executableArgument);
  const entries = command === "stamp"
    ? await stampWinVersionInfo(executablePath)
    : await verifyWinVersionInfo(executablePath);
  const iconGroups = await verifyWinIconInfo(executablePath);
  printVerified(executablePath, entries, iconGroups);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`    ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

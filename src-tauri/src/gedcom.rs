use crate::db::{self, AppResult, Store};
use rusqlite::params;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_IMPORT_BYTES: u64 = 100_000_000;

#[derive(Default)]
struct ImportedPerson {
    xref: String,
    name: String,
    sex: String,
    adoptive_families: HashSet<String>,
    variants: Vec<String>,
    notes: Vec<String>,
    facts: Vec<ImportedFact>,
    media: Vec<ImportedMedia>,
}
#[derive(Default, Clone)]
struct ImportedMedia {
    reference: Option<String>,
    file: String,
    title: String,
}
#[derive(Default, Clone)]
struct ImportedFact {
    kind: String,
    date: String,
    place: String,
    detail: String,
    notes: Vec<String>,
    source_xref: Option<String>,
}
#[derive(Default)]
struct Family {
    xref: String,
    husband: Option<String>,
    wife: Option<String>,
    children: Vec<String>,
    notes: Vec<String>,
    facts: Vec<ImportedFact>,
    relationship_label: String,
}
#[derive(Default)]
struct Parsed {
    people: Vec<ImportedPerson>,
    families: Vec<Family>,
    sources: HashMap<String, String>,
    source_repositories: HashMap<String, String>,
    repositories: HashMap<String, String>,
    notes: HashMap<String, String>,
    media_records: HashMap<String, ImportedMedia>,
    warnings: Vec<String>,
    encoding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub people_count: usize,
    pub relationship_count: usize,
    pub source_count: usize,
    pub warnings: Vec<String>,
    pub encoding: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub phase: &'static str,
    pub completed: usize,
    pub total: usize,
}

fn read_gedcom(path: &str) -> AppResult<(Vec<u8>, String)> {
    let path = Path::new(path);
    let is_zip = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        let mut raw = Vec::new();
        fs::File::open(path).map_err(|e| e.to_string())?
            .take(MAX_IMPORT_BYTES + 1).read_to_end(&mut raw).map_err(|e| e.to_string())?;
        if raw.len() as u64 > MAX_IMPORT_BYTES {
            return Err("GEDCOM exceeds the 100 MB import limit".into());
        }
        return Ok((
            raw,
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        ));
    }
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.name().to_lowercase().ends_with(".ged") {
            if file.size() > MAX_IMPORT_BYTES {
                return Err("GEDCOM exceeds the 100 MB import limit".into());
            }
            let mut out = Vec::new();
            (&mut file).take(MAX_IMPORT_BYTES + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
            if out.len() as u64 > MAX_IMPORT_BYTES { return Err("GEDCOM exceeds the 100 MB import limit".into()); }
            return Ok((out, file.name().to_string()));
        }
    }
    Err("ZIP contains no GEDCOM file".into())
}

fn parse(path: &str) -> AppResult<Parsed> {
    let (bytes, _name) = read_gedcom(path)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err("GEDCOM exceeds the 100 MB import limit".into());
    }
    let mut parsed = Parsed::default();
    let text = if bytes.starts_with(&[0xff, 0xfe]) {
        parsed
            .warnings
            .push("UTF-16LE GEDCOM decoded; review names and places after import.".into());
        String::from_utf16_lossy(
            &bytes[2..]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        parsed
            .warnings
            .push("UTF-16BE GEDCOM decoded; review names and places after import.".into());
        String::from_utf16_lossy(
            &bytes[2..]
                .chunks_exact(2)
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
    } else if let Ok(utf8) = std::str::from_utf8(&bytes) {
        utf8.trim_start_matches('\u{feff}').to_string()
    } else {
        parsed.warnings.push("Non-UTF-8 characters were decoded as Latin-1. ANSEL and legacy encodings may need manual correction; the original file is preserved.".into());
        bytes.iter().map(|b| *b as char).collect::<String>()
    };
    if !text.lines().any(|l| l.trim_start().starts_with("0 HEAD"))
        || !text.lines().any(|l| l.trim_start().starts_with("0 TRLR"))
    {
        return Err("Not a complete GEDCOM: HEAD or TRLR is missing".into());
    }
    let mut person: Option<ImportedPerson> = None;
    let mut family: Option<Family> = None;
    let mut source_xref: Option<String> = None;
    let mut repository_xref: Option<String> = None;
    let mut note_xref: Option<String> = None;
    let mut media_xref: Option<String> = None;
    let mut current_event: Option<usize> = None;
    let mut current_famc: Option<String> = None;
    let mut current_family_event: Option<usize> = None;
    let mut current_person_note = false;
    let mut current_family_note = false;
    let mut current_event_note = false;
    let mut current_family_event_note = false;
    let mut current_source_title = false;
    let mut current_person_media: Option<usize> = None;
    let mut unsupported = HashMap::<String, usize>::new();
    let mut media_references = 0usize;
    for line in text.lines() {
        let mut parts = line.trim_end_matches('\r').splitn(3, ' ');
        let level = parts
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            .ok_or("Malformed GEDCOM level")?;
        let second = parts.next().unwrap_or("");
        let third = parts.next().unwrap_or("");
        let (xref, tag, value) = if second.starts_with('@') && level == 0 {
            let mut p = third.splitn(2, ' ');
            (Some(second), p.next().unwrap_or(""), p.next().unwrap_or(""))
        } else {
            (None, second, third)
        };
        if level == 0 {
            if let Some(p) = person.take() {
                parsed.people.push(p);
            }
            if let Some(f) = family.take() {
                parsed.families.push(f);
            }
            source_xref = None;
            repository_xref = None;
            note_xref = None;
            media_xref = None;
            current_event = None;
            current_famc = None;
            current_family_event = None;
            current_person_note = false;
            current_family_note = false;
            current_event_note = false;
            current_family_event_note = false;
            current_source_title = false;
            current_person_media = None;
            match tag {
                "INDI" => {
                    person = Some(ImportedPerson {
                        xref: xref.unwrap_or("").into(),
                        ..Default::default()
                    })
                }
                "FAM" => {
                    family = Some(Family {
                        xref: xref.unwrap_or("").into(),
                        ..Default::default()
                    })
                }
                "SOUR" => {
                    source_xref = xref.map(str::to_string);
                    if let Some(x) = xref {
                        parsed.sources.insert(x.into(), String::new());
                    }
                }
                "REPO" => {
                    repository_xref = xref.map(str::to_string);
                    if let Some(x) = xref {
                        parsed.repositories.insert(x.into(), String::new());
                    }
                }
                "NOTE" => {
                    note_xref = xref.map(str::to_string);
                    if let Some(x) = xref {
                        parsed.notes.insert(x.into(), value.into());
                    }
                }
                "OBJE" => {
                    media_references += 1;
                    if let Some(x) = xref {
                        media_xref = Some(x.into());
                        parsed.media_records.entry(x.into()).or_default();
                    }
                }
                "HEAD" | "TRLR" | "SUBM" => {}
                other => *unsupported.entry(other.into()).or_default() += 1,
            }
            continue;
        }
        if tag == "CHAR" && level == 1 {
            parsed.encoding = value.into();
            if value != "UTF-8" && value != "UNICODE" {
                parsed.warnings.push(format!(
                    "Declared encoding {value}; non-UTF-8 characters need review."
                ));
            }
        }
        if let Some(p) = person.as_mut() {
            if level == 1 {
                current_event = None;
                current_famc = None;
                current_person_note = false;
                current_event_note = false;
                current_person_media = None;
                match tag {
                    "NAME" => {
                        let cleaned = value
                            .replace('/', "")
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ");
                        if p.name.is_empty() {
                            p.name = cleaned
                        } else {
                            p.variants.push(cleaned)
                        }
                    }
                    "NOTE" => {
                        p.notes.push(value.into());
                        current_person_note = true;
                    }
                    "BIRT" | "DEAT" | "BAPM" | "CHR" | "MARR" | "BURI" | "RESI" | "IMMI"
                    | "NATU" | "CENS" | "OCCU" | "EVEN" | "ADOP" | "EMIG" | "ORDN" | "RETI"
                    | "_MILT" | "_MDCL" | "PROB" | "FACT" => {
                        p.facts.push(ImportedFact {
                            kind: match tag {
                                "BIRT" => "birth",
                                "DEAT" => "death",
                                "BAPM" | "CHR" => "baptism",
                                "MARR" => "marriage",
                                "BURI" => "burial",
                                "RESI" => "residence",
                                "IMMI" => "immigration",
                                "NATU" => "naturalization",
                                "CENS" => "census",
                                "OCCU" => "occupation",
                                "_MILT" => "military",
                                "EMIG" => "emigration",
                                "ADOP" => "adoption",
                                "ORDN" => "ordination",
                                "RETI" => "retirement",
                                "_MDCL" => "medical",
                                "PROB" => "probate",
                                _ => "other",
                            }
                            .into(),
                            detail: if tag == "EVEN"
                                || tag == "FACT"
                                || !value.is_empty() && value != "Y"
                            {
                                value.into()
                            } else {
                                String::new()
                            },
                            ..Default::default()
                        });
                        current_event = Some(p.facts.len() - 1)
                    }
                    "FAMC" => current_famc = Some(value.into()),
                    "FAMS" | "CHAN" => {}
                    "SEX" => p.sex = value.into(),
                    "TITL" => {
                        p.notes.push(format!("Title: {value}"));
                        current_person_note = true;
                    }
                    "OBJE" | "_PHOTO" => {
                        media_references += 1;
                        p.media.push(ImportedMedia {
                            reference: (!value.is_empty()).then(|| value.into()),
                            ..Default::default()
                        });
                        current_person_media = Some(p.media.len() - 1);
                    }
                    "GRAD" => {
                        p.facts.push(ImportedFact {
                            kind: "other".into(),
                            detail: if value.is_empty() {
                                "Graduation".into()
                            } else {
                                format!("Graduation: {value}")
                            },
                            ..Default::default()
                        });
                        current_event = Some(p.facts.len() - 1)
                    }
                    "_WLNK" => {
                        p.notes.push(format!("Web link: {value}"));
                        current_person_note = true;
                    }
                    "SOUR" => p.notes.push(format!("GEDCOM source reference: {value}")),
                    other => *unsupported.entry(format!("INDI:{other}")).or_default() += 1,
                }
            } else if level == 2 {
                if let Some(index) = current_person_media {
                    if tag == "FILE" {
                        p.media[index].file = value.into();
                    }
                    if tag == "TITL" {
                        p.media[index].title = value.into();
                    }
                } else if let Some(index) = current_event {
                    match tag {
                        "DATE" => p.facts[index].date = value.into(),
                        "PLAC" => p.facts[index].place = value.into(),
                        "SOUR" => p.facts[index].source_xref = Some(value.into()),
                        "TYPE" => {
                            let detail = &mut p.facts[index].detail;
                            if !detail.is_empty() {
                                detail.push_str("; ");
                            }
                            detail.push_str(&format!("Type: {value}"));
                        }
                        "NOTE" => {
                            p.facts[index].notes.push(value.into());
                            current_event_note = true;
                        }
                        "CONC" | "CONT" => {
                            if tag == "CONT" {
                                p.facts[index].detail.push('\n');
                            }
                            p.facts[index].detail.push_str(value);
                        }
                        "CAUS" => {
                            if !p.facts[index].detail.is_empty() {
                                p.facts[index].detail.push_str("; ");
                            }
                            p.facts[index].detail.push_str(&format!("Cause: {value}"));
                        }
                        "FAMC" => {
                            if p.facts[index].kind == "adoption" {
                                p.adoptive_families.insert(value.into());
                            }
                        }
                        "OBJE" => {
                            media_references += 1;
                            p.media.push(ImportedMedia {
                                reference: (!value.is_empty()).then(|| value.into()),
                                ..Default::default()
                            });
                            current_person_media = Some(p.media.len() - 1);
                        }
                        other => *unsupported.entry(format!("EVENT:{other}")).or_default() += 1,
                    }
                } else if tag == "PEDI" && value.eq_ignore_ascii_case("adopted") {
                    if let Some(xref) = current_famc.as_ref() {
                        p.adoptive_families.insert(xref.clone());
                    }
                } else if tag == "CONC" || tag == "CONT" {
                    if current_person_note {
                        if let Some(n) = p.notes.last_mut() {
                            if tag == "CONT" {
                                n.push('\n')
                            }
                            n.push_str(value);
                        }
                    }
                } else if tag == "TITL" && current_person_note {
                    if let Some(note) = p.notes.last_mut() {
                        note.push_str(&format!(" · {value}"));
                    }
                }
            } else if level >= 3 && current_person_media.is_some() {
                let index = current_person_media.unwrap();
                if tag == "FILE" {
                    p.media[index].file = value.into();
                }
                if tag == "TITL" {
                    p.media[index].title = value.into();
                }
            } else if level >= 3 && current_event_note {
                if tag == "CONC" || tag == "CONT" {
                    if let Some(index) = current_event {
                        if let Some(note) = p.facts[index].notes.last_mut() {
                            if tag == "CONT" {
                                note.push('\n');
                            }
                            note.push_str(value);
                        }
                    }
                }
            }
        } else if let Some(f) = family.as_mut() {
            if level == 1 {
                current_family_event = None;
                current_family_note = false;
                current_family_event_note = false;
                match tag {
                    "HUSB" => f.husband = Some(value.into()),
                    "WIFE" => f.wife = Some(value.into()),
                    "MARR" | "DIV" | "ENGA" | "EVEN" => {
                        f.facts.push(ImportedFact {
                            kind: match tag {
                                "MARR" => "marriage",
                                "DIV" => "divorce",
                                "ENGA" => "engagement",
                                _ => "other",
                            }
                            .into(),
                            detail: if value == "Y" {
                                String::new()
                            } else {
                                value.into()
                            },
                            ..Default::default()
                        });
                        current_family_event = Some(f.facts.len() - 1);
                    }
                    "NOTE" => {
                        f.notes.push(value.into());
                        current_family_note = true;
                    }
                    "SOUR" => f.notes.push(format!("GEDCOM source reference: {value}")),
                    "CHIL" => f.children.push(value.into()),
                    "_SREL" => {
                        f.notes.push(format!("Relationship: {value}"));
                        f.relationship_label = value.into();
                        if !value.trim().is_empty() && !value.eq_ignore_ascii_case("married") {
                            f.facts.push(ImportedFact {
                                kind: "other".into(),
                                detail: format!("Relationship: {value}"),
                                ..Default::default()
                            });
                        }
                    }
                    other => *unsupported.entry(format!("FAM:{other}")).or_default() += 1,
                }
            } else if level == 2 {
                if let Some(index) = current_family_event {
                    match tag {
                        "DATE" => f.facts[index].date = value.into(),
                        "PLAC" => f.facts[index].place = value.into(),
                        "SOUR" => f.facts[index].source_xref = Some(value.into()),
                        "TYPE" => {
                            let detail = &mut f.facts[index].detail;
                            if !detail.is_empty() {
                                detail.push_str("; ");
                            }
                            detail.push_str(&format!("Type: {value}"));
                        }
                        "NOTE" => {
                            f.facts[index].notes.push(value.into());
                            current_family_event_note = true;
                        }
                        "CONC" | "CONT" => {
                            if tag == "CONT" {
                                f.facts[index].detail.push('\n');
                            }
                            f.facts[index].detail.push_str(value);
                        }
                        "CAUS" => {
                            if !f.facts[index].detail.is_empty() {
                                f.facts[index].detail.push_str("; ");
                            }
                            f.facts[index].detail.push_str(&format!("Cause: {value}"));
                        }
                        other => {
                            *unsupported
                                .entry(format!("FAMILY_EVENT:{other}"))
                                .or_default() += 1
                        }
                    }
                } else if (tag == "CONT" || tag == "CONC") && current_family_note {
                    if let Some(note) = f.notes.last_mut() {
                        if tag == "CONT" {
                            note.push('\n');
                        }
                        note.push_str(value);
                    }
                }
            } else if level >= 3 && current_family_event_note {
                if tag == "CONC" || tag == "CONT" {
                    if let Some(index) = current_family_event {
                        if let Some(note) = f.facts[index].notes.last_mut() {
                            if tag == "CONT" {
                                note.push('\n');
                            }
                            note.push_str(value);
                        }
                    }
                }
            }
        } else if let Some(x) = media_xref.as_ref() {
            if level == 1 && tag == "FILE" {
                parsed.media_records.entry(x.clone()).or_default().file = value.into();
            } else if level == 1 && tag == "TITL" {
                parsed.media_records.entry(x.clone()).or_default().title = value.into();
            }
        } else if let Some(x) = source_xref.as_ref() {
            if level == 1 && (tag == "TITL" || tag == "ABBR") {
                parsed.sources.insert(x.clone(), value.into());
                current_source_title = true;
            } else if level == 1 && tag == "REPO" {
                parsed.source_repositories.insert(x.clone(), value.into());
                current_source_title = false;
            } else if level == 1 {
                current_source_title = false;
            } else if level >= 2 && current_source_title && (tag == "CONC" || tag == "CONT") {
                if let Some(title) = parsed.sources.get_mut(x) {
                    if tag == "CONT" {
                        title.push('\n');
                    }
                    title.push_str(value);
                }
            }
        } else if let Some(x) = repository_xref.as_ref() {
            if level == 1 && tag == "NAME" {
                parsed.repositories.insert(x.clone(), value.into());
            }
        } else if let Some(x) = note_xref.as_ref() {
            if level >= 1 && (tag == "CONC" || tag == "CONT") {
                if let Some(note) = parsed.notes.get_mut(x) {
                    if tag == "CONT" {
                        note.push('\n');
                    }
                    note.push_str(value);
                }
            }
        }
    }
    if parsed.people.is_empty() {
        return Err("GEDCOM contains no people".into());
    }
    let mut identifiers = HashSet::new();
    for person in &parsed.people {
        if person.xref.is_empty() || !identifiers.insert(person.xref.clone()) {
            return Err("GEDCOM has a missing or duplicate person identifier".into());
        }
    }
    let shared_notes = parsed.notes.clone();
    let mut missing_notes = 0usize;
    let resolve_note = |value: &str, missing: &mut usize| -> String {
        if value.starts_with('@') && value.ends_with('@') {
            match shared_notes.get(value) {
                Some(text) => text.clone(),
                None => {
                    *missing += 1;
                    format!("Unresolved GEDCOM note reference: {value}")
                }
            }
        } else {
            value.to_string()
        }
    };
    for person in &mut parsed.people {
        for note in &mut person.notes {
            *note = resolve_note(note, &mut missing_notes);
        }
        for fact in &mut person.facts {
            for note in &fact.notes {
                if !fact.detail.is_empty() {
                    fact.detail.push('\n');
                }
                fact.detail
                    .push_str(&resolve_note(note, &mut missing_notes));
            }
        }
        for media in &mut person.media {
            if media.file.is_empty() {
                if let Some(reference) = media.reference.as_ref() {
                    if let Some(record) = parsed.media_records.get(reference) {
                        media.file = record.file.clone();
                        if media.title.is_empty() {
                            media.title = record.title.clone();
                        }
                    }
                }
            }
        }
    }
    let people_by_xref: HashMap<String, usize> = parsed
        .people
        .iter()
        .enumerate()
        .map(|(i, p)| (p.xref.clone(), i))
        .collect();
    for family in &mut parsed.families {
        for fact in &mut family.facts {
            for note in &fact.notes {
                if !fact.detail.is_empty() {
                    fact.detail.push('\n');
                }
                fact.detail
                    .push_str(&resolve_note(note, &mut missing_notes));
            }
        }
    }
    for family in &parsed.families {
        let members = [&family.husband, &family.wife]
            .into_iter()
            .flatten()
            .filter_map(|xref| people_by_xref.get(xref).copied())
            .collect::<HashSet<_>>();
        for index in members {
            let person = &mut parsed.people[index];
            for note in &family.notes {
                person.notes.push(format!(
                    "Family note: {}",
                    resolve_note(note, &mut missing_notes)
                ));
            }
            person.facts.extend(family.facts.iter().cloned());
        }
    }
    if missing_notes > 0 {
        parsed.warnings.push(format!("{missing_notes} shared note reference(s) could not be resolved; their identifiers were retained in person notes."));
    }
    for (source, repository) in &parsed.source_repositories {
        if !parsed.repositories.contains_key(repository) {
            parsed.warnings.push(format!("Source {source} refers to repository {repository}, which is missing from this GEDCOM."));
        }
    }
    let linked_repositories: HashSet<&str> = parsed
        .source_repositories
        .values()
        .map(String::as_str)
        .collect();
    let unlinked_repositories = parsed
        .repositories
        .keys()
        .filter(|xref| !linked_repositories.contains(xref.as_str()))
        .count();
    if unlinked_repositories > 0 {
        parsed.warnings.push(format!("{unlinked_repositories} repository record(s) have no linked source and remain in the original GEDCOM only."));
    }
    let unresolved = parsed
        .families
        .iter()
        .flat_map(|f| {
            f.husband
                .iter()
                .chain(f.wife.iter())
                .chain(f.children.iter())
        })
        .filter(|xref| !identifiers.contains(xref.as_str()))
        .count();
    if unresolved > 0 {
        parsed.warnings.push(format!(
            "{unresolved} relationship reference(s) point to people not present in this GEDCOM"
        ));
    }
    for (tag, count) in unsupported {
        parsed.warnings.push(format!(
            "{count} unsupported {tag} tag(s) retained in the original file"
        ));
    }
    if parsed.people.iter().any(|p| p.name.is_empty()) {
        parsed
            .warnings
            .push("Some people have no name and will appear as Unknown person.".into());
    }
    let media = parsed
        .people
        .iter()
        .flat_map(|person| person.media.iter())
        .collect::<Vec<_>>();
    if !media.is_empty() || media_references > 0 {
        let mut available = 0;
        let mut oversized = 0;
        for item in &media {
            if item.file.is_empty() { continue; }
            match read_local_media(path, &item.file) {
                Ok(LocalMedia::Available(_)) => available += 1,
                Ok(LocalMedia::Oversized) => oversized += 1,
                _ => {}
            }
        }
        let unresolved = media.len().saturating_sub(available + oversized);
        if available > 0 {
            parsed.warnings.push(format!(
                "{available} locally available media file(s) will be copied into this tree."
            ));
        }
        if unresolved > 0 {
            parsed.warnings.push(format!("{unresolved} media reference(s) could not be resolved locally and will remain in the original GEDCOM."));
        }
        if oversized > 0 {
            parsed.warnings.push(format!("{oversized} media file(s) exceed the 100 MB per-file limit and will be skipped. The original import is preserved."));
        }
    }
    Ok(parsed)
}

fn safe_media_path(value: &str) -> Option<PathBuf> {
    if value.contains("://") {
        return None;
    }
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    (!normalized.is_empty()).then(|| path.to_path_buf())
}

enum LocalMedia { Missing, Oversized, Available(Vec<u8>) }

fn read_local_media(import_path: &str, reference: &str) -> AppResult<LocalMedia> {
    let relative = match safe_media_path(reference) {
        Some(value) => value,
        None => return Ok(LocalMedia::Missing),
    };
    let path = Path::new(import_path);
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let target = relative.to_string_lossy().replace('\\', "/");
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|e| e.to_string())?;
            if entry.is_dir() || entry.name().replace('\\', "/") != target {
                continue;
            }
            if entry.size() > MAX_IMPORT_BYTES { return Ok(LocalMedia::Oversized); }
            let mut bytes = Vec::new();
            entry.take(MAX_IMPORT_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            return Ok(if bytes.len() as u64 > MAX_IMPORT_BYTES { LocalMedia::Oversized } else { LocalMedia::Available(bytes) });
        }
        return Ok(LocalMedia::Missing);
    }
    let base = match path.parent() {
        Some(parent) => fs::canonicalize(parent).map_err(|e| e.to_string())?,
        None => return Ok(LocalMedia::Missing),
    };
    let candidate = base.join(relative);
    let canonical = match fs::canonicalize(candidate) {
        Ok(value) => value,
        Err(_) => return Ok(LocalMedia::Missing),
    };
    if !canonical.starts_with(&base) || !canonical.is_file() {
        return Ok(LocalMedia::Missing);
    }
    let file = fs::File::open(canonical).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_IMPORT_BYTES { return Ok(LocalMedia::Oversized); }
    let mut bytes = Vec::new();
    file.take(MAX_IMPORT_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(if bytes.len() as u64 > MAX_IMPORT_BYTES { LocalMedia::Oversized } else { LocalMedia::Available(bytes) })
}

pub fn preview(path: &str) -> AppResult<ImportPreview> {
    let parsed = parse(path)?;
    let relationship_count = parsed
        .families
        .iter()
        .map(|f| {
            f.children.len() * usize::from(f.husband.is_some())
                + f.children.len() * usize::from(f.wife.is_some())
                + usize::from(f.husband.is_some() && f.wife.is_some())
        })
        .sum();
    Ok(ImportPreview {
        people_count: parsed.people.len(),
        relationship_count,
        source_count: parsed.sources.len(),
        warnings: parsed.warnings,
        encoding: parsed.encoding,
    })
}

#[cfg(test)]
pub fn import(store: &Store, path: &str, name: String) -> AppResult<String> {
    import_with_progress(store, path, name, |_| {})
}

pub fn import_with_progress(
    store: &Store,
    path: &str,
    name: String,
    progress: impl Fn(ImportProgress),
) -> AppResult<String> {
    progress(ImportProgress {
        phase: "reading",
        completed: 0,
        total: 0,
    });
    let parsed = parse(path)?;
    progress(ImportProgress {
        phase: "copying",
        completed: 0,
        total: 0,
    });
    let tree = db::create_import_tree(store, name)?;
    let result = (|| -> AppResult<()> {
        let original = Path::new(path);
        let target = store.tree_dir(&tree.id)?.join(format!(
            "original-import.{}",
            original
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("ged")
        ));
        fs::copy(original, target).map_err(|e| e.to_string())?;
        let mut c = store.tree(&tree.id)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let mut person_ids = HashMap::new();
        progress(ImportProgress {
            phase: "people",
            completed: 0,
            total: parsed.people.len(),
        });
        for (index, p) in parsed.people.iter().enumerate() {
            let pid = db::id();
            person_ids.insert(p.xref.clone(), pid.clone());
            tx.execute(
                "INSERT INTO people(id,name,notes,living_status,sex) VALUES(?1,?2,?3,'unknown',?4)",
                params![
                    pid,
                    if p.name.is_empty() {
                        "Unknown person"
                    } else {
                        &p.name
                    },
                    p.notes.join("\n"),
                    p.sex
                ],
            )
            .map_err(|e| e.to_string())?;
            for variant in &p.variants {
                tx.execute(
                    "INSERT INTO names(id,person_id,value) VALUES(?1,?2,?3)",
                    params![db::id(), pid, variant],
                )
                .map_err(|e| e.to_string())?;
            }
            if (index + 1) % 100 == 0 || index + 1 == parsed.people.len() {
                progress(ImportProgress {
                    phase: "people",
                    completed: index + 1,
                    total: parsed.people.len(),
                });
            }
        }
        for person in &parsed.people {
            let Some(person_id) = person_ids.get(&person.xref) else {
                continue;
            };
            for media in &person.media {
                if media.file.is_empty() {
                    continue;
                }
                let LocalMedia::Available(bytes) = read_local_media(path, &media.file)? else {
                    continue;
                };
                let name = if !media.title.trim().is_empty() {
                    media.title.clone()
                } else {
                    Path::new(&media.file)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Imported media")
                        .to_string()
                };
                let attachment_id = db::id();
                let relative_path = format!("media/{attachment_id}");
                fs::write(store.tree_dir(&tree.id)?.join(&relative_path), bytes)
                    .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO attachments(id,person_id,name,relative_path,content_type,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![attachment_id, person_id, name, relative_path, db::content_type_for_name(&media.file), db::now()],
                ).map_err(|e| e.to_string())?;
            }
        }
        let mut source_ids = HashMap::new();
        progress(ImportProgress {
            phase: "sources",
            completed: 0,
            total: parsed.sources.len(),
        });
        for (index, (xref, title)) in parsed.sources.iter().enumerate() {
            let sid = db::id();
            source_ids.insert(xref.clone(), sid.clone());
            let repository_note = parsed
                .source_repositories
                .get(xref)
                .map(|repository| {
                    let name = parsed
                        .repositories
                        .get(repository)
                        .filter(|name| !name.is_empty());
                    match name {
                        Some(name) => format!("Repository: {name} ({repository})"),
                        None => format!("Repository: {repository}"),
                    }
                })
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO sources(id,title,citation,notes) VALUES(?1,?2,?3,?4)",
                params![
                    sid,
                    if title.is_empty() {
                        "Imported GEDCOM source"
                    } else {
                        title
                    },
                    xref,
                    repository_note
                ],
            )
            .map_err(|e| e.to_string())?;
            if (index + 1) % 100 == 0 || index + 1 == parsed.sources.len() {
                progress(ImportProgress {
                    phase: "sources",
                    completed: index + 1,
                    total: parsed.sources.len(),
                });
            }
        }
        let fact_total: usize = parsed.people.iter().map(|person| person.facts.len()).sum();
        let mut fact_count = 0;
        progress(ImportProgress {
            phase: "facts",
            completed: 0,
            total: fact_total,
        });
        for p in &parsed.people {
            let pid = &person_ids[&p.xref];
            for f in &p.facts {
                tx.execute("INSERT INTO facts(id,person_id,kind,date_text,place,detail,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6,'gedcom',?7)",params![db::id(),pid,f.kind,f.date,f.place,f.detail,f.source_xref.as_ref().and_then(|x|source_ids.get(x))]).map_err(|e|e.to_string())?;
                fact_count += 1;
                if fact_count % 100 == 0 || fact_count == fact_total {
                    progress(ImportProgress {
                        phase: "facts",
                        completed: fact_count,
                        total: fact_total,
                    });
                }
            }
        }
        let adopted_families: HashSet<(String, String)> = parsed
            .people
            .iter()
            .flat_map(|p| {
                p.adoptive_families
                    .iter()
                    .map(|f| (p.xref.clone(), f.clone()))
            })
            .collect();
        progress(ImportProgress {
            phase: "relationships",
            completed: 0,
            total: parsed.families.len(),
        });
        for (index, f) in parsed.families.iter().enumerate() {
            for parent in [&f.husband, &f.wife].into_iter().flatten() {
                for child in &f.children {
                    if let (Some(from), Some(to)) = (person_ids.get(parent), person_ids.get(child))
                    {
                        let kind = if adopted_families.contains(&(child.clone(), f.xref.clone())) {
                            "adoptive_parent"
                        } else {
                            "unknown_parent"
                        };
                        tx.execute("INSERT INTO relationships(id,from_id,to_id,kind,provenance) VALUES(?1,?2,?3,?4,'gedcom')",params![db::id(),from,to,kind]).map_err(|e|e.to_string())?;
                    }
                }
            }
            if let (Some(Some(a)), Some(Some(b))) = (
                f.husband.as_ref().map(|x| person_ids.get(x)),
                f.wife.as_ref().map(|x| person_ids.get(x)),
            ) {
                let kind = if f.facts.iter().any(|event| event.kind == "marriage")
                    && (f.relationship_label.is_empty()
                        || f.relationship_label.eq_ignore_ascii_case("married"))
                {
                    "spouse"
                } else {
                    "partner"
                };
                tx.execute("INSERT INTO relationships(id,from_id,to_id,kind,provenance) VALUES(?1,?2,?3,?4,'gedcom')",params![db::id(),a,b,kind]).map_err(|e|e.to_string())?;
            }
            if (index + 1) % 100 == 0 || index + 1 == parsed.families.len() {
                progress(ImportProgress {
                    phase: "relationships",
                    completed: index + 1,
                    total: parsed.families.len(),
                });
            }
        }
        progress(ImportProgress {
            phase: "finalizing",
            completed: 0,
            total: 0,
        });
        db::insert_change(
            &tx,
            "Imported GEDCOM",
            "import",
            &[db::ChangeSubject::context("tree", tree.name.as_str())],
            None,
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        db::complete_import_tree(store, &tree.id)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = db::delete_tree(store, &tree.id);
        return Err(e);
    }
    Ok(tree.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn import_reports_progress_and_only_publishes_complete_tree() {
        let base = std::env::temp_dir().join(format!("kinfolk-progress-test-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("progress.ged");
        fs::write(
            &path,
            "0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Ada /Sample/\n1 BIRT\n2 DATE 1900\n0 TRLR\n",
        )
        .unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let seen = RefCell::new(Vec::new());
        let tree_id = import_with_progress(
            &store,
            path.to_str().unwrap(),
            "Progress".into(),
            |update| {
                if update.phase == "people" {
                    assert!(db::list_trees(&store).unwrap().is_empty());
                }
                seen.borrow_mut()
                    .push((update.phase, update.completed, update.total));
            },
        )
        .unwrap();
        assert_eq!(db::list_trees(&store).unwrap()[0].id, tree_id);
        assert!(seen.borrow().contains(&("people", 1, 1)));
        assert_eq!(seen.borrow().last().unwrap().0, "finalizing");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn failed_import_removes_pending_tree() {
        let base = std::env::temp_dir().join(format!("kinfolk-failed-import-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("missing-after-parse.ged");
        fs::write(
            &path,
            "0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Ada /Sample/\n0 TRLR\n",
        )
        .unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let result =
            import_with_progress(&store, path.to_str().unwrap(), "Failed".into(), |update| {
                if update.phase == "copying" {
                    fs::remove_file(&path).unwrap();
                }
            });
        assert!(result.is_err());
        assert!(db::list_trees(&store).unwrap().is_empty());
        let count: i64 = store
            .catalog()
            .unwrap()
            .query_row("SELECT count(*) FROM trees", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn import_preserves_original_and_links_people() {
        let base = std::env::temp_dir().join(format!("kinfolk-gedcom-test-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("sample.ged");
        fs::write(&path,"0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME María /Rossi/\n1 BIRT\n2 DATE ABT 1880\n2 PLAC Roma\n0 @I2@ INDI\n1 NAME Luca /Rossi/\n0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n0 TRLR\n").unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let preview = super::preview(path.to_str().unwrap()).unwrap();
        assert_eq!(preview.people_count, 2);
        assert_eq!(preview.relationship_count, 1);
        let tree_id = super::import(&store, path.to_str().unwrap(), "Imported".into()).unwrap();
        assert_eq!(db::list_people(&store, &tree_id, None).unwrap().len(), 2);
        assert_eq!(db::list_relationships(&store, &tree_id).unwrap().len(), 1);
        assert!(store
            .tree_dir(&tree_id)
            .unwrap()
            .join("original-import.ged")
            .exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn extended_demo_imports_and_surfaces_planted_review_items() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/demo-expanded.ged");
        let preview = preview(path).unwrap();
        assert_eq!(preview.people_count, 25);
        assert_eq!(preview.source_count, 3);
        assert_eq!(preview.relationship_count, 39);
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);

        let base = std::env::temp_dir().join(format!("foreloom-demo-test-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = import(&store, path, "Expanded demo".into()).unwrap();
        assert!(db::list_people(&store, &tree_id, None).unwrap().iter().any(|person| {
            person.name == "Jonah Vale" && person.facts.iter().any(|fact| {
                fact.kind == "death" && fact.date_text == "1868" && fact.detail.contains("1968")
            })
        }));
        let issues = crate::issues::list_issues(&store, &tree_id).unwrap();
        for kind in ["chronology", "birthplace", "duplicate", "connection", "unlinked"] {
            assert!(issues.iter().any(|issue| issue.kind == kind), "missing {kind}");
        }
        assert!(issues.iter().any(|issue| issue.kind == "chronology" && issue.proposed_fact_id.is_some()));
        assert!(issues.iter().any(|issue| issue.kind == "duplicate" && issue.merge_candidate.is_some()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn common_gedcom_tags_import_without_false_unsupported_warnings() {
        let base = std::env::temp_dir().join(format!("kinfolk-gedcom-tags-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("tags.ged");
        fs::write(&path, "0 HEAD\n1 CHAR UTF-8\n0 @N1@ NOTE Shared note\n1 CONT second line\n0 @M1@ OBJE\n1 FILE missing-photo.jpg\n0 @I1@ INDI\n1 NAME Ada /Sample/\n1 SEX F\n1 TITL Dr.\n1 NOTE @N1@\n1 OBJE @M1@\n1 _PHOTO @M1@\n1 _MILT\n2 DATE 1940\n1 _MDCL\n2 DATE 1950\n1 ORDN\n1 EMIG\n1 RETI\n1 ADOP\n2 FAMC @F1@\n1 FAMC @F1@\n2 PEDI adopted\n0 @I2@ INDI\n1 NAME Bo /Sample/\n1 SEX M\n0 @F1@ FAM\n1 HUSB @I2@\n1 CHIL @I1@\n1 MARR\n2 DATE 1930\n2 PLAC Rome\n2 NOTE @N1@\n1 ENGA\n1 DIV\n1 EVEN Ceremony\n2 CAUS Family gathering\n1 NOTE @N1@\n0 TRLR\n").unwrap();
        let parsed = parse(path.to_str().unwrap()).unwrap();
        assert_eq!(parsed.people[0].sex, "F");
        assert!(parsed.people[0]
            .notes
            .iter()
            .any(|n| n.contains("Shared note\nsecond line")));
        assert!(parsed.people[1].facts.iter().any(|f| f.kind == "marriage"
            && f.date == "1930"
            && f.place == "Rome"
            && f.detail.contains("Shared note")));
        assert!(parsed.people[0].facts.iter().any(|f| f.kind == "military"));
        assert!(
            parsed.warnings.iter().all(|w| !w.contains("unsupported")),
            "{:?}",
            parsed.warnings
        );
        assert_eq!(
            parsed
                .warnings
                .iter()
                .filter(|w| w.contains("could not be resolved locally"))
                .count(),
            1
        );
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = super::import(&store, path.to_str().unwrap(), "Tags".into()).unwrap();
        let people = db::list_people(&store, &tree_id, None).unwrap();
        let ada = people.iter().find(|p| p.name == "Ada Sample").unwrap();
        assert_eq!(ada.sex, "F");
        assert!(people
            .iter()
            .find(|p| p.name == "Bo Sample")
            .unwrap()
            .facts
            .iter()
            .any(|f| f.kind == "marriage"));
        assert!(db::list_relationships(&store, &tree_id)
            .unwrap()
            .iter()
            .any(|r| r.kind == "adoptive_parent"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn imports_ancestry_extensions_and_local_person_media() {
        let base = std::env::temp_dir().join(format!("kinfolk-gedcom-extension-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("portrait.jpg"), [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        let path = base.join("extensions.ged");
        fs::write(&path, "0 HEAD\n1 CHAR UTF-8\n0 @M1@ OBJE\n1 FILE portrait.jpg\n1 TITL Portrait\n0 @I1@ INDI\n1 NAME Ada /Sample/\n1 GRAD University\n2 DATE 1920\n1 _WLNK https://example.test/ada\n2 TITL Ada biography\n1 EVEN Award\n2 OBJE @M1@\n0 @I2@ INDI\n1 NAME Bo /Sample/\n0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 _SREL friend\n0 TRLR\n").unwrap();
        let parsed = parse(path.to_str().unwrap()).unwrap();
        assert!(
            parsed
                .warnings
                .iter()
                .all(|warning| !warning.contains("unsupported")),
            "{:?}",
            parsed.warnings
        );
        assert!(parsed.people[0]
            .facts
            .iter()
            .any(|fact| fact.detail.contains("Graduation")));
        assert!(parsed.people[0]
            .notes
            .iter()
            .any(|note| note.contains("Ada biography")));
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = import(&store, path.to_str().unwrap(), "Extensions".into()).unwrap();
        let ada = db::list_people(&store, &tree_id, None)
            .unwrap()
            .into_iter()
            .find(|person| person.name == "Ada Sample")
            .unwrap();
        let attachments = db::list_attachments(&store, &tree_id, &ada.id).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].content_type, "image/jpeg");
        assert!(db::list_relationships(&store, &tree_id)
            .unwrap()
            .iter()
            .any(|relationship| relationship.kind == "partner"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn oversized_media_is_warned_and_skipped() {
        use std::io::Write;
        let base = std::env::temp_dir().join(format!("foreloom-large-media-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        fs::File::create(base.join("large.jpg")).unwrap().set_len(MAX_IMPORT_BYTES + 1).unwrap();
        let path = base.join("tree.ged");
        fs::write(&path, "0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Mara /Vale/\n1 OBJE\n2 FILE large.jpg\n0 TRLR\n").unwrap();
        let preview = super::preview(path.to_str().unwrap()).unwrap();
        assert!(preview.warnings.iter().any(|warning| warning.contains("1 media file(s) exceed the 100 MB")));
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = super::import(&store, path.to_str().unwrap(), "Large media".into()).unwrap();
        let person = db::list_people(&store, &tree_id, None).unwrap().remove(0);
        assert!(db::list_attachments(&store, &tree_id, &person.id).unwrap().is_empty());

        let zip_path = base.join("tree.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("tree.ged", options).unwrap();
        zip.write_all(b"0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Mara /Vale/\n1 OBJE\n2 FILE large.jpg\n0 TRLR\n").unwrap();
        zip.start_file("large.jpg", options).unwrap();
        std::io::copy(&mut std::io::repeat(0).take(MAX_IMPORT_BYTES + 1), &mut zip).unwrap();
        zip.finish().unwrap();
        let preview = super::preview(zip_path.to_str().unwrap()).unwrap();
        assert!(preview.warnings.iter().any(|warning| warning.contains("1 media file(s) exceed the 100 MB")));
        let tree_id = super::import(&store, zip_path.to_str().unwrap(), "Large zipped media".into()).unwrap();
        let person = db::list_people(&store, &tree_id, None).unwrap().remove(0);
        assert!(db::list_attachments(&store, &tree_id, &person.id).unwrap().is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn imports_probate_typed_facts_and_repository_details() {
        let base = std::env::temp_dir().join(format!("kinfolk-gedcom-probate-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("details.ged");
        fs::write(&path, "0 HEAD\n1 CHAR UTF-8\n0 @R1@ REPO\n1 NAME County Archives\n0 @S1@ SOUR\n1 TITL Probate register\n1 REPO @R1@\n0 @I1@ INDI\n1 NAME Ada /Sample/\n1 PROB\n2 DATE 1905\n2 PLAC Rome\n2 SOUR @S1@\n1 FACT Woodworking\n2 TYPE Skills\n0 TRLR\n").unwrap();
        let preview = super::preview(path.to_str().unwrap()).unwrap();
        assert!(preview
            .warnings
            .iter()
            .all(|warning| !warning.contains("unsupported")));
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = super::import(&store, path.to_str().unwrap(), "Details".into()).unwrap();
        let person = db::list_people(&store, &tree_id, None).unwrap().remove(0);
        assert!(person.facts.iter().any(|fact| fact.kind == "probate"
            && fact.date_text == "1905"
            && fact.place == "Rome"
            && fact.source_id.is_some()));
        assert!(person
            .facts
            .iter()
            .any(|fact| fact.kind == "other" && fact.detail == "Woodworking; Type: Skills"));
        let source = db::list_sources(&store, &tree_id).unwrap().remove(0);
        assert_eq!(source.notes, "Repository: County Archives (@R1@)");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    #[ignore = "Set KINFOLK_GEDCOM_FILE to audit a local export in a temporary tree"]
    fn preview_external_file_when_requested() {
        let path = std::env::var("KINFOLK_GEDCOM_FILE").expect("KINFOLK_GEDCOM_FILE is required");
        let preview = super::preview(&path).unwrap();
        println!(
            "people={} links={} sources={}",
            preview.people_count, preview.relationship_count, preview.source_count
        );
        for warning in preview.warnings {
            println!("{warning}");
        }
        let base = std::env::temp_dir().join(format!("kinfolk-external-import-{}", db::id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree_id = super::import(&store, &path, "Import audit".into()).unwrap();
        assert_eq!(
            db::list_people(&store, &tree_id, None).unwrap().len(),
            preview.people_count
        );
        assert_eq!(
            db::list_relationships(&store, &tree_id).unwrap().len(),
            preview.relationship_count
        );
        fs::remove_dir_all(base).unwrap();
    }
}

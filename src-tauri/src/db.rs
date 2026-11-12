use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub type AppResult<T> = Result<T, String>;

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(8);

fn open_connection(path: PathBuf) -> AppResult<Connection> {
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    // Commands use short-lived connections. Wait for a concurrent command to
    // finish its write rather than returning SQLite's immediate "database is
    // locked" error to the UI.
    c.busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|e| e.to_string())?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| e.to_string())?;
    Ok(c)
}

#[derive(Clone)]
pub struct Store {
    pub base: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub people_count: i64,
}

/// The minimum data needed to make a tree interactive. Secondary data such as
/// sources, history, and review issues is deliberately loaded by its feature.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeCore {
    pub people: Vec<Person>,
    pub relationships: Vec<Relationship>,
    pub home_person_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub person_id: String,
    pub kind: String,
    pub date_text: String,
    pub place: String,
    pub detail: String,
    pub provenance: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub variants: Vec<String>,
    pub notes: String,
    pub living_status: String,
    pub sex: String,
    pub version: i64,
    pub preferred_birth_fact_id: Option<String>,
    pub facts: Vec<Fact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactInput {
    pub id: Option<String>,
    pub kind: String,
    pub date_text: String,
    pub place: String,
    pub detail: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonInput {
    pub id: Option<String>,
    pub name: String,
    pub variants: Vec<String>,
    pub notes: String,
    pub living_status: String,
    #[serde(default)]
    pub sex: String,
    pub facts: Vec<FactInput>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub provenance: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub title: String,
    pub url: String,
    pub citation: String,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub person_id: String,
    pub name: String,
    pub relative_path: String,
    pub content_type: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDependency {
    pub person_id: String,
    pub name: String,
    pub relationships: i64,
    pub facts: i64,
    pub attachments: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portrait {
    pub person_id: String,
    pub attachment_id: String,
    pub data_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSubject {
    pub kind: String,
    pub id: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl ChangeSubject {
    pub fn person(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            kind: "person".into(),
            id: Some(id.into()),
            label: label.into(),
            role: None,
        }
    }

    pub fn person_with_role(
        id: impl Into<String>,
        label: impl Into<String>,
        role: impl Into<String>,
    ) -> Self {
        let role = role.into();
        Self {
            kind: role.to_lowercase(),
            id: Some(id.into()),
            label: label.into(),
            role: Some(role),
        }
    }

    pub fn context(kind: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: None,
            label: label.into(),
            role: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub created_at: String,
    pub summary: String,
    pub kind: String,
    pub can_undo: bool,
    pub subjects: Vec<ChangeSubject>,
}

pub fn now() -> String {
    Utc::now().to_rfc3339()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}

impl Store {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let s = Self { base };
        s.remove_legacy_analytics_data()?;
        s.cleanup_incomplete_imports()?;
        Ok(s)
    }
    fn remove_legacy_analytics_data(&self) -> AppResult<()> {
        self.catalog()?.execute(
            "DELETE FROM catalog_meta WHERE key IN ('analytics_consent', 'analytics_installation_id')",
            [],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn catalog(&self) -> AppResult<Connection> {
        let c = open_connection(self.base.join("catalog.sqlite"))?;
        c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS trees(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready'); CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e| e.to_string())?;
        let has_state: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('trees') WHERE name='state'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_state == 0 {
            c.execute(
                "ALTER TABLE trees ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        c.execute(
            "INSERT OR IGNORE INTO catalog_meta(key,value) VALUES('last_opened_tree_id','')",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(c)
    }
    fn cleanup_incomplete_imports(&self) -> AppResult<()> {
        let c = self.catalog()?;
        let mut stmt = c
            .prepare("SELECT id FROM trees WHERE state='importing'")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for id in ids {
            let dir = self.base.join("trees").join(&id);
            if dir.exists() {
                fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            }
            c.execute("DELETE FROM trees WHERE id=?1", [&id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn tree_dir(&self, tree_id: &str) -> AppResult<PathBuf> {
        Uuid::parse_str(tree_id).map_err(|_| "Invalid tree ID".to_string())?;
        let exists: bool = self
            .catalog()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM trees WHERE id=?1)",
                [tree_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("Tree not found".into());
        }
        Ok(self.base.join("trees").join(tree_id))
    }
    pub fn tree(&self, tree_id: &str) -> AppResult<Connection> {
        let path = self.tree_dir(tree_id)?.join("tree.sqlite");
        let c = open_connection(path)?;
        let has_sex: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('people') WHERE name='sex'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_sex == 0 {
            c.execute(
                "ALTER TABLE people ADD COLUMN sex TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        let has_preferred_birth_fact: i64 = c
            .query_row("SELECT count(*) FROM pragma_table_info('people') WHERE name='preferred_birth_fact_id'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if has_preferred_birth_fact == 0 {
            c.execute(
                "ALTER TABLE people ADD COLUMN preferred_birth_fact_id TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        let has_change_subjects: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('changes') WHERE name='subjects_json'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_change_subjects == 0 {
            c.execute(
                "ALTER TABLE changes ADD COLUMN subjects_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        let has_attachment_content_type: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('attachments') WHERE name='content_type'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_attachment_content_type == 0 {
            c.execute(
                "ALTER TABLE attachments ADD COLUMN content_type TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        let has_attachment_created_at: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('attachments') WHERE name='created_at'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_attachment_created_at == 0 {
            c.execute(
                "ALTER TABLE attachments ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        c.execute_batch("CREATE TABLE IF NOT EXISTS issue_suggestions(issue_key TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, suggestion_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(issue_key,model)); CREATE TABLE IF NOT EXISTS birthplace_resolutions(person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,preferred_fact_id TEXT NOT NULL,alternatives_json TEXT NOT NULL,reviewed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reviewed_issues(issue_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,reviewed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS intentional_disconnected_groups(fingerprint TEXT PRIMARY KEY,acknowledged_at TEXT NOT NULL);")
            .map_err(|e| e.to_string())?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS place_overrides(raw_place_key TEXT PRIMARY KEY,gazetteer_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS place_resolutions(fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,status TEXT NOT NULL,gazetteer_id TEXT,label TEXT NOT NULL DEFAULT '',locality TEXT NOT NULL DEFAULT '',county TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',country_code TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'manual',confidence TEXT NOT NULL DEFAULT 'medium',rationale TEXT NOT NULL DEFAULT '',context_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);")
            .map_err(|e| e.to_string())?;
        c.execute_batch("CREATE INDEX IF NOT EXISTS idx_names_person ON names(person_id); CREATE INDEX IF NOT EXISTS idx_attachments_person ON attachments(person_id); CREATE INDEX IF NOT EXISTS idx_facts_person_kind ON facts(person_id,kind);")
            .map_err(|e| e.to_string())?;
        enrich_change_subjects(&c)?;
        Ok(c)
    }
}

const SCHEMA: &str = "
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key,value) VALUES('revision','0');
INSERT OR IGNORE INTO meta(key,value) VALUES('home_person_id','');
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',living_status TEXT NOT NULL DEFAULT 'unknown',sex TEXT NOT NULL DEFAULT '',preferred_birth_fact_id TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS names(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',citation TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,kind TEXT NOT NULL,date_text TEXT NOT NULL DEFAULT '',place TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',provenance TEXT NOT NULL,source_id TEXT REFERENCES sources(id),version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS relationships(id TEXT PRIMARY KEY,from_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,to_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,kind TEXT NOT NULL,provenance TEXT NOT NULL,source_id TEXT REFERENCES sources(id),version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,name TEXT NOT NULL,relative_path TEXT NOT NULL,content_type TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,summary TEXT NOT NULL,kind TEXT NOT NULL,inverse_json TEXT,forward_json TEXT,undone INTEGER NOT NULL DEFAULT 0,subjects_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS dismissed_issues(issue_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,dismissed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intentional_disconnected_groups(fingerprint TEXT PRIMARY KEY,acknowledged_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviewed_issues(issue_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,reviewed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_suggestions(issue_key TEXT NOT NULL,fingerprint TEXT NOT NULL,model TEXT NOT NULL,suggestion_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(issue_key,model));
CREATE TABLE IF NOT EXISTS birthplace_resolutions(person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,preferred_fact_id TEXT NOT NULL,alternatives_json TEXT NOT NULL,reviewed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_sessions(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,query_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,source_id TEXT NOT NULL,external_id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,details_json TEXT NOT NULL,accessed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS place_overrides(raw_place_key TEXT PRIMARY KEY,gazetteer_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS place_resolutions(fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,status TEXT NOT NULL,gazetteer_id TEXT,label TEXT NOT NULL DEFAULT '',locality TEXT NOT NULL DEFAULT '',county TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',country_code TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'manual',confidence TEXT NOT NULL DEFAULT 'medium',rationale TEXT NOT NULL DEFAULT '',context_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_names_person ON names(person_id);
CREATE INDEX IF NOT EXISTS idx_facts_person ON facts(person_id);
CREATE INDEX IF NOT EXISTS idx_facts_person_kind ON facts(person_id,kind);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_attachments_person ON attachments(person_id);
";

fn change(
    c: &Connection,
    summary: &str,
    kind: &str,
    subjects: &[ChangeSubject],
    inverse: Option<&str>,
    forward: Option<&str>,
) -> AppResult<String> {
    let change_id = id();
    let subjects_json = serde_json::to_string(subjects).map_err(|e| e.to_string())?;
    c.execute("INSERT INTO changes(id,created_at,summary,kind,inverse_json,forward_json,subjects_json) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![change_id,now(),summary,kind,inverse,forward,subjects_json]).map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(change_id)
}

fn relationship_label(kind: &str) -> &str {
    match kind {
        "biological_parent" => "biological parent",
        "adoptive_parent" => "adoptive parent",
        "step_parent" => "step parent",
        "unknown_parent" => "parent (type unknown)",
        "spouse" => "spouse",
        "partner" => "partner",
        _ => "relationship",
    }
}

fn person_subject(c: &Connection, person_id: &str) -> AppResult<ChangeSubject> {
    let name: String = c
        .query_row("SELECT name FROM people WHERE id=?1", [person_id], |row| {
            row.get(0)
        })
        .map_err(|_| "Person not found in this tree".to_string())?;
    Ok(ChangeSubject::person(person_id, name))
}

pub fn subjects_for_people(
    store: &Store,
    tree_id: &str,
    person_ids: &[String],
) -> AppResult<Vec<ChangeSubject>> {
    let c = store.tree(tree_id)?;
    person_ids.iter().map(|id| person_subject(&c, id)).collect()
}

fn subjects_from_summary(summary: &str) -> Vec<ChangeSubject> {
    for prefix in ["Added person: ", "Edited person: ", "Set home person: "] {
        if let Some(name) = summary.strip_prefix(prefix).filter(|name| !name.is_empty()) {
            return vec![ChangeSubject {
                kind: "person".into(),
                id: None,
                label: name.into(),
                role: None,
            }];
        }
    }
    if let Some(details) = summary
        .strip_prefix("Added relationship: ")
        .or_else(|| summary.strip_prefix("Removed relationship: "))
    {
        let parts = details.split(" — ").collect::<Vec<_>>();
        if parts.len() == 3 && !parts[0].is_empty() && !parts[2].is_empty() {
            return vec![
                ChangeSubject {
                    kind: "person".into(),
                    id: None,
                    label: parts[0].into(),
                    role: None,
                },
                ChangeSubject {
                    kind: "person".into(),
                    id: None,
                    label: parts[2].into(),
                    role: None,
                },
            ];
        }
    }
    if let Some(details) = summary.strip_prefix("Attached media: ") {
        if let Some((_, name)) = details.rsplit_once(" to ") {
            if !name.is_empty() {
                return vec![ChangeSubject {
                    kind: "person".into(),
                    id: None,
                    label: name.into(),
                    role: None,
                }];
            }
        }
    }
    Vec::new()
}

fn subjects_from_change(
    c: &Connection,
    summary: &str,
    inverse: Option<&str>,
) -> Vec<ChangeSubject> {
    if let Some(inverse) = inverse {
        if let Ok(merge) = serde_json::from_str::<MergeUndo>(inverse) {
            if merge.kind == "merge_people" {
                return vec![
                    ChangeSubject::person_with_role(
                        merge.snapshot.survivor.id,
                        merge.snapshot.survivor.name,
                        "Kept",
                    ),
                    ChangeSubject::person_with_role(
                        merge.snapshot.duplicate.id,
                        merge.snapshot.duplicate.name,
                        "Merged",
                    ),
                ];
            }
        }
        if let Ok(fact) = serde_json::from_str::<Fact>(inverse) {
            if let Ok(subject) = person_subject(c, &fact.person_id) {
                return vec![subject];
            }
        }
    }
    subjects_from_summary(summary)
}

fn enrich_change_subjects(c: &Connection) -> AppResult<()> {
    let mut statement = c
        .prepare("SELECT id,summary,inverse_json,subjects_json FROM changes")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);

    for (id, summary, inverse, stored_subjects) in rows {
        if serde_json::from_str::<Vec<ChangeSubject>>(&stored_subjects)
            .unwrap_or_default()
            .is_empty()
        {
            let subjects = subjects_from_change(c, &summary, inverse.as_deref());
            if !subjects.is_empty() {
                let serialized = serde_json::to_string(&subjects).map_err(|e| e.to_string())?;
                c.execute(
                    "UPDATE changes SET subjects_json=?1 WHERE id=?2",
                    params![serialized, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub fn revision(c: &Connection) -> AppResult<i64> {
    c.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn home_person_id(store: &Store, tree_id: &str) -> AppResult<Option<String>> {
    let c = store.tree(tree_id)?;
    home_person_id_from(&c)
}

fn home_person_id_from(c: &Connection) -> AppResult<Option<String>> {
    let value = c
        .query_row(
            "SELECT value FROM meta WHERE key='home_person_id'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(person_id) = value.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM people WHERE id=?1)",
            [&person_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        Ok(Some(person_id))
    } else {
        c.execute("UPDATE meta SET value='' WHERE key='home_person_id'", [])
            .map_err(|e| e.to_string())?;
        Ok(None)
    }
}

pub fn set_home_person_id(store: &Store, tree_id: &str, person_id: &str) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let person_name: String = c
        .query_row("SELECT name FROM people WHERE id=?1", [person_id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Home person not found in this tree")?;
    let current: String = c
        .query_row(
            "SELECT value FROM meta WHERE key='home_person_id'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if current == person_id {
        return Ok(());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO meta(key,value) VALUES('home_person_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [person_id],
    )
    .map_err(|e| e.to_string())?;
    change(
        &tx,
        "Set home person",
        "manual",
        &[ChangeSubject::person(person_id, person_name)],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn clear_home_person_id(store: &Store, tree_id: &str) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let current: String = c
        .query_row(
            "SELECT value FROM meta WHERE key='home_person_id'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if current.is_empty() {
        return Ok(());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE meta SET value='' WHERE key='home_person_id'", [])
        .map_err(|e| e.to_string())?;
    change(
        &tx,
        "Cleared home person",
        "manual",
        &[ChangeSubject::context("tree", "Home person")],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn last_opened_tree_id(store: &Store) -> AppResult<Option<String>> {
    let c = store.catalog()?;
    let value: String = c
        .query_row(
            "SELECT value FROM catalog_meta WHERE key='last_opened_tree_id'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if value.is_empty() {
        return Ok(None);
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM trees WHERE id=?1 AND state='ready')",
            [&value],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        Ok(Some(value))
    } else {
        c.execute(
            "UPDATE catalog_meta SET value='' WHERE key='last_opened_tree_id'",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(None)
    }
}

pub fn set_last_opened_tree_id(store: &Store, tree_id: &str) -> AppResult<()> {
    store.tree_dir(tree_id)?;
    store.catalog()?.execute("INSERT INTO catalog_meta(key,value) VALUES('last_opened_tree_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [tree_id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_trees(store: &Store) -> AppResult<Vec<Tree>> {
    let c = store.catalog()?;
    let mut stmt = c
        .prepare(
            "SELECT id,name,created_at FROM trees WHERE state='ready' ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for row in rows {
        let (id, name, created_at) = row.map_err(|e| e.to_string())?;
        let people_count = store
            .tree(&id)?
            .query_row("SELECT count(*) FROM people", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        out.push(Tree {
            id,
            name,
            created_at,
            people_count,
        });
    }
    Ok(out)
}

pub fn create_tree(store: &Store, name: String) -> AppResult<Tree> {
    create_tree_with_state(store, name, "ready")
}

pub fn create_import_tree(store: &Store, name: String) -> AppResult<Tree> {
    create_tree_with_state(store, name, "importing")
}

pub fn complete_import_tree(store: &Store, tree_id: &str) -> AppResult<()> {
    let count = store
        .catalog()?
        .execute(
            "UPDATE trees SET state='ready' WHERE id=?1 AND state='importing'",
            [tree_id],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err("Importing tree not found".into());
    }
    Ok(())
}

fn create_tree_with_state(store: &Store, name: String, state: &str) -> AppResult<Tree> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a tree name".into());
    }
    let tree_id = id();
    let dir = store.base.join("trees").join(&tree_id);
    fs::create_dir_all(dir.join("media")).map_err(|e| e.to_string())?;
    let c = open_connection(dir.join("tree.sqlite"))?;
    c.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let created_at = now();
    store
        .catalog()?
        .execute(
            "INSERT INTO trees(id,name,created_at,state) VALUES(?1,?2,?3,?4)",
            params![tree_id, name, created_at, state],
        )
        .map_err(|e| e.to_string())?;
    change(
        &c,
        "Created tree",
        "manual",
        &[ChangeSubject::context("tree", name)],
        None,
        None,
    )?;
    Ok(Tree {
        id: tree_id,
        name: name.into(),
        created_at,
        people_count: 0,
    })
}

pub fn rename_tree(store: &Store, tree_id: &str, name: String) -> AppResult<()> {
    store.tree_dir(tree_id)?;
    if name.trim().is_empty() {
        return Err("Enter a tree name".into());
    }
    let name = name.trim();
    store
        .catalog()?
        .execute(
            "UPDATE trees SET name=?1 WHERE id=?2",
            params![name, tree_id],
        )
        .map_err(|e| e.to_string())?;
    change(
        &store.tree(tree_id)?,
        "Renamed tree",
        "manual",
        &[ChangeSubject::context("tree", name)],
        None,
        None,
    )?;
    Ok(())
}

pub fn delete_tree(store: &Store, tree_id: &str) -> AppResult<()> {
    let dir = store.tree_dir(tree_id)?;
    fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    let catalog = store.catalog()?;
    catalog
        .execute("DELETE FROM trees WHERE id=?1", [tree_id])
        .map_err(|e| e.to_string())?;
    catalog
        .execute(
            "UPDATE catalog_meta SET value='' WHERE key='last_opened_tree_id' AND value=?1",
            [tree_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod import_state_tests {
    use super::*;

    #[test]
    fn removes_legacy_analytics_data_without_touching_other_settings() {
        let base = std::env::temp_dir().join(format!("kinfolk-privacy-cleanup-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        let catalog = store.catalog().unwrap();
        catalog.execute_batch("INSERT INTO catalog_meta(key,value) VALUES('analytics_consent','yes'),('analytics_installation_id','old-id');").unwrap();
        store.remove_legacy_analytics_data().unwrap();
        let remaining: Vec<String> = catalog.prepare("SELECT key FROM catalog_meta ORDER BY key").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(remaining, vec!["last_opened_tree_id"]);
        drop(catalog);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn startup_cleanup_removes_interrupted_imports_only() {
        let base = std::env::temp_dir().join(format!("kinfolk-import-cleanup-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let ready = create_tree(&store, "Ready".into()).unwrap();
        let pending = create_import_tree(&store, "Pending".into()).unwrap();
        assert_eq!(list_trees(&store).unwrap().len(), 1);
        store.cleanup_incomplete_imports().unwrap();
        assert_eq!(list_trees(&store).unwrap()[0].id, ready.id);
        assert!(!base.join("trees").join(pending.id).exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn home_person_is_persisted_and_rejects_people_outside_the_tree() {
        let base = std::env::temp_dir().join(format!("kinfolk-home-person-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = create_tree(&store, "Home".into()).unwrap();
        let person = save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Home".into(),
                variants: vec![],
                notes: "".into(),
                living_status: "unknown".into(),
                sex: "".into(),
                facts: vec![],
            },
        )
        .unwrap();
        assert_eq!(home_person_id(&store, &tree.id).unwrap(), None);
        set_home_person_id(&store, &tree.id, &person.id).unwrap();
        assert_eq!(home_person_id(&store, &tree.id).unwrap(), Some(person.id));
        assert!(set_home_person_id(&store, &tree.id, "missing-person").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn core_tree_load_returns_only_the_interactive_tree_data() {
        let base = std::env::temp_dir().join(format!("kinfolk-core-tree-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = create_tree(&store, "Core".into()).unwrap();
        let parent = save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada".into(),
                variants: vec!["Augusta".into()],
                notes: "A long research note that should not be sent to the tree canvas.".into(),
                living_status: "unknown".into(),
                sex: "".into(),
                facts: vec![
                    FactInput { id: None, kind: "birth".into(), date_text: "1815".into(), place: "London".into(), detail: "detail".into(), source_id: None },
                    FactInput { id: None, kind: "occupation".into(), date_text: "1835".into(), place: "London".into(), detail: "mathematician".into(), source_id: None },
                ],
            },
        )
        .unwrap();
        let child = save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Byron".into(),
                variants: vec![],
                notes: "".into(),
                living_status: "unknown".into(),
                sex: "".into(),
                facts: vec![],
            },
        )
        .unwrap();
        add_relationship(
            &store,
            &tree.id,
            parent.id.clone(),
            child.id.clone(),
            "biological_parent".into(),
            None,
        )
        .unwrap();
        set_home_person_id(&store, &tree.id, &parent.id).unwrap();

        let core = load_tree_core(&store, &tree.id).unwrap();
        assert_eq!(core.people.len(), 2);
        assert_eq!(core.relationships.len(), 1);
        assert_eq!(core.home_person_id, Some(parent.id));
        let ada = core.people.iter().find(|person| person.name == "Ada").unwrap();
        assert!(ada.notes.is_empty());
        assert!(ada.variants.is_empty());
        assert_eq!(ada.facts.iter().map(|fact| fact.kind.as_str()).collect::<Vec<_>>(), vec!["birth"]);
        assert_eq!(ada.facts[0].date_text, "1815");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn last_opened_tree_is_persisted_and_cleared_when_deleted() {
        let base = std::env::temp_dir().join(format!("kinfolk-last-tree-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = create_tree(&store, "Recent".into()).unwrap();
        assert_eq!(last_opened_tree_id(&store).unwrap(), None);
        set_last_opened_tree_id(&store, &tree.id).unwrap();
        assert_eq!(last_opened_tree_id(&store).unwrap(), Some(tree.id.clone()));
        delete_tree(&store, &tree.id).unwrap();
        assert_eq!(last_opened_tree_id(&store).unwrap(), None);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn change_history_records_people_and_preserves_them_for_undo() {
        let base = std::env::temp_dir().join(format!("kinfolk-change-subjects-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = create_tree(&store, "History".into()).unwrap();
        let person = save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Lovelace".into(),
                variants: vec![],
                notes: "".into(),
                living_status: "deceased".into(),
                sex: "".into(),
                facts: vec![FactInput {
                    id: None,
                    kind: "birth".into(),
                    date_text: "1815".into(),
                    place: "London".into(),
                    detail: "".into(),
                    source_id: None,
                }],
            },
        )
        .unwrap();
        let saved = list_changes(&store, &tree.id).unwrap();
        assert_eq!(saved[0].summary, "Added person");
        assert_eq!(saved[0].subjects[0].label, "Ada Lovelace");

        let change_id = delete_fact_for_suggestion(
            &store,
            &tree.id,
            &person.facts[0].id,
            revision(&store.tree(&tree.id).unwrap()).unwrap(),
        )
        .unwrap();
        undo_change(&store, &tree.id, &change_id).unwrap();
        let undone = list_changes(&store, &tree.id).unwrap();
        assert_eq!(undone[0].summary, "Undid approved suggestion");
        assert_eq!(undone[0].subjects[0].label, "Ada Lovelace");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn merge_history_records_roles_and_enriches_legacy_rows() {
        let base = std::env::temp_dir().join(format!("kinfolk-merge-history-{}", id()));
        fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = create_tree(&store, "History".into()).unwrap();
        let input = |name: &str| PersonInput {
            id: None,
            name: name.into(),
            variants: vec![],
            notes: "".into(),
            living_status: "unknown".into(),
            sex: "".into(),
            facts: vec![],
        };
        let kept = save_person(&store, &tree.id, input("Ada Lovelace")).unwrap();
        let merged = save_person(&store, &tree.id, input("Ada Byron")).unwrap();
        let change_id = merge_people_for_suggestion(
            &store,
            &tree.id,
            &kept.id,
            &merged.id,
            revision(&store.tree(&tree.id).unwrap()).unwrap(),
            MergePlanInput { primary_name: kept.name.clone(), preferred_birth_fact_id: None, decisions: std::collections::HashMap::new() },
        )
        .unwrap();
        let c = store.tree(&tree.id).unwrap();
        c.execute(
            "UPDATE changes SET subjects_json='[]' WHERE id=?1",
            [&change_id],
        )
        .unwrap();
        drop(c);

        let history = list_changes(&store, &tree.id).unwrap();
        let merge = history
            .iter()
            .find(|change| change.id == change_id)
            .unwrap();
        assert_eq!(merge.subjects[0].role.as_deref(), Some("Kept"));
        assert_eq!(merge.subjects[0].label, "Ada Lovelace");
        assert_eq!(merge.subjects[1].role.as_deref(), Some("Merged"));
        assert_eq!(merge.subjects[1].label, "Ada Byron");
        fs::remove_dir_all(base).unwrap();
    }
}

pub fn list_people(store: &Store, tree_id: &str, search: Option<String>) -> AppResult<Vec<Person>> {
    let c = store.tree(tree_id)?;
    list_people_from(&c, search)
}

/// The tree canvas and people index only need identifying information and the
/// two display dates. Keeping research notes, alternate names, and the full
/// event timeline out of this response keeps large trees cheap to open.
fn list_people_summaries_from(c: &Connection) -> AppResult<Vec<Person>> {
    let mut stmt = c.prepare(
        "SELECT p.id,p.name,p.living_status,p.sex,p.preferred_birth_fact_id,p.version,
            (SELECT date_text FROM facts WHERE person_id=p.id AND kind='birth' ORDER BY date_text,id LIMIT 1),
            (SELECT date_text FROM facts WHERE person_id=p.id AND kind='death' ORDER BY date_text,id LIMIT 1)
         FROM people p ORDER BY p.name",
    ).map_err(|e| e.to_string())?;
    let people = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let birth: Option<String> = r.get(6)?;
        let death: Option<String> = r.get(7)?;
        let mut facts = Vec::with_capacity(2);
        if let Some(date_text) = birth {
            facts.push(Fact { id: String::new(), person_id: id.clone(), kind: "birth".into(), date_text, place: String::new(), detail: String::new(), provenance: String::new(), source_id: None });
        }
        if let Some(date_text) = death {
            facts.push(Fact { id: String::new(), person_id: id.clone(), kind: "death".into(), date_text, place: String::new(), detail: String::new(), provenance: String::new(), source_id: None });
        }
        Ok(Person {
            id,
            name: r.get(1)?,
            variants: vec![],
            notes: String::new(),
            living_status: r.get(2)?,
            sex: r.get(3)?,
            preferred_birth_fact_id: r.get(4)?,
            version: r.get(5)?,
            facts,
        })
    }).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(people)
}

fn list_people_from(c: &Connection, search: Option<String>) -> AppResult<Vec<Person>> {
    let pattern = format!(
        "%{}%",
        search
            .unwrap_or_default()
            .trim()
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt=c.prepare("SELECT DISTINCT p.id,p.name,p.notes,p.living_status,p.sex,p.preferred_birth_fact_id,p.version FROM people p LEFT JOIN names n ON n.person_id=p.id WHERE p.name LIKE ?1 ESCAPE '\\' OR n.value LIKE ?1 ESCAPE '\\' ORDER BY p.name").map_err(|e|e.to_string())?;
    let mut people = stmt
        .query_map([pattern], |r| {
            Ok(Person {
                id: r.get(0)?,
                name: r.get(1)?,
                notes: r.get(2)?,
                living_status: r.get(3)?,
                sex: r.get(4)?,
                preferred_birth_fact_id: r.get(5)?,
                version: r.get(6)?,
                variants: vec![],
                facts: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if people.is_empty() {
        return Ok(people);
    }
    let mut positions = HashMap::new();
    people.iter().enumerate().for_each(|(index, person)| {
        positions.insert(person.id.clone(), index);
    });
    let mut names = c
        .prepare("SELECT person_id,value FROM names ORDER BY value")
        .map_err(|e| e.to_string())?;
    for row in names
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (person_id, value) = row.map_err(|e| e.to_string())?;
        if let Some(index) = positions.get(&person_id) {
            people[*index].variants.push(value);
        }
    }
    let mut facts = c.prepare("SELECT id,person_id,kind,date_text,place,detail,provenance,source_id FROM facts ORDER BY person_id,kind,date_text").map_err(|e| e.to_string())?;
    for row in facts
        .query_map([], |r| {
            Ok(Fact {
                id: r.get(0)?,
                person_id: r.get(1)?,
                kind: r.get(2)?,
                date_text: r.get(3)?,
                place: r.get(4)?,
                detail: r.get(5)?,
                provenance: r.get(6)?,
                source_id: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
    {
        let fact = row.map_err(|e| e.to_string())?;
        if let Some(index) = positions.get(&fact.person_id) {
            people[*index].facts.push(fact);
        }
    }
    Ok(people)
}

fn get_person_from(c: &Connection, person_id: &str) -> AppResult<Person> {
    let (name, notes, living_status, sex, preferred_birth_fact_id, version) = c
        .query_row(
            "SELECT name,notes,living_status,sex,preferred_birth_fact_id,version FROM people WHERE id=?1",
            [person_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut names_stmt = c
        .prepare("SELECT value FROM names WHERE person_id=?1 ORDER BY value")
        .map_err(|e| e.to_string())?;
    let variants = names_stmt
        .query_map([person_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut facts_stmt=c.prepare("SELECT id,person_id,kind,date_text,place,detail,provenance,source_id FROM facts WHERE person_id=?1 ORDER BY kind,date_text").map_err(|e|e.to_string())?;
    let facts = facts_stmt
        .query_map([person_id], |r| {
            Ok(Fact {
                id: r.get(0)?,
                person_id: r.get(1)?,
                kind: r.get(2)?,
                date_text: r.get(3)?,
                place: r.get(4)?,
                detail: r.get(5)?,
                provenance: r.get(6)?,
                source_id: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Person {
        id: person_id.into(),
        name,
        variants,
        notes,
        living_status,
        sex,
        preferred_birth_fact_id,
        version,
        facts,
    })
}

pub fn get_person(store: &Store, tree_id: &str, person_id: &str) -> AppResult<Person> {
    get_person_from(&store.tree(tree_id)?, person_id)
}

pub fn preview_people_deletion(
    store: &Store,
    tree_id: &str,
    person_ids: &[String],
) -> AppResult<Vec<CleanupDependency>> {
    let c = store.tree(tree_id)?;
    let mut preview = Vec::with_capacity(person_ids.len());
    for person_id in person_ids {
        let name: String = c.query_row("SELECT name FROM people WHERE id=?1", [person_id], |row| row.get(0)).map_err(|_| "A selected person was not found")?;
        let relationships = c.query_row("SELECT count(*) FROM relationships WHERE from_id=?1 OR to_id=?1", [person_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        let facts = c.query_row("SELECT count(*) FROM facts WHERE person_id=?1", [person_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        let attachments = c.query_row("SELECT count(*) FROM attachments WHERE person_id=?1", [person_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        preview.push(CleanupDependency { person_id: person_id.clone(), name, relationships, facts, attachments });
    }
    Ok(preview)
}

pub fn delete_people(store: &Store, tree_id: &str, person_ids: &[String]) -> AppResult<()> {
    if person_ids.is_empty() { return Err("Select at least one person to delete".into()); }
    let preview = preview_people_deletion(store, tree_id, person_ids)?;
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    for person in &preview {
        tx.execute("DELETE FROM people WHERE id=?1", [&person.person_id]).map_err(|e| e.to_string())?;
    }
    let subjects = preview.iter().map(|person| ChangeSubject::person(person.person_id.as_str(), person.name.clone())).collect::<Vec<_>>();
    change(&tx, &format!("Deleted {} cleanup record{}", preview.len(), if preview.len() == 1 { "" } else { "s" }), "cleanup", &subjects, None, None)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn save_person(store: &Store, tree_id: &str, input: PersonInput) -> AppResult<Person> {
    if input.name.trim().is_empty() {
        return Err("Enter a person's name".into());
    }
    if !["living", "deceased", "unknown"].contains(&input.living_status.as_str()) {
        return Err("Invalid living status".into());
    }
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let person_id = input.id.unwrap_or_else(id);
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM people WHERE id=?1)",
            [&person_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        tx.execute(
            "UPDATE people SET name=?1,notes=?2,living_status=?3,sex=?4,version=version+1 WHERE id=?5",
            params![
                input.name.trim(),
                input.notes,
                input.living_status,
                input.sex,
                person_id
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "INSERT INTO people(id,name,notes,living_status,sex) VALUES(?1,?2,?3,?4,?5)",
            params![
                person_id,
                input.name.trim(),
                input.notes,
                input.living_status,
                input.sex
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM names WHERE person_id=?1", [&person_id])
        .map_err(|e| e.to_string())?;
    for variant in input
        .variants
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        tx.execute(
            "INSERT INTO names(id,person_id,value) VALUES(?1,?2,?3)",
            params![id(), person_id, variant],
        )
        .map_err(|e| e.to_string())?;
    }
    let keep: Vec<String> = input.facts.iter().filter_map(|f| f.id.clone()).collect();
    let mut old = tx
        .prepare("SELECT id FROM facts WHERE person_id=?1")
        .map_err(|e| e.to_string())?;
    let old_ids = old
        .query_map([&person_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(old);
    for old_id in old_ids {
        if !keep.contains(&old_id) {
            tx.execute("DELETE FROM facts WHERE id=?1", [old_id])
                .map_err(|e| e.to_string())?;
        }
    }
    for fact in input.facts {
        if fact.kind.trim().is_empty()
            || (fact.id.is_none()
                && fact.date_text.trim().is_empty()
                && fact.place.trim().is_empty()
                && fact.detail.trim().is_empty())
        {
            continue;
        }
        if let Some(fact_id) = fact.id {
            let count=tx.execute("UPDATE facts SET kind=?1,date_text=?2,place=?3,detail=?4,source_id=?5,version=version+1 WHERE id=?6 AND person_id=?7",params![fact.kind,fact.date_text,fact.place,fact.detail,fact.source_id,fact_id,person_id]).map_err(|e|e.to_string())?;
            if count == 0 {
                return Err("Fact does not belong to this person".into());
            }
        } else {
            tx.execute("INSERT INTO facts(id,person_id,kind,date_text,place,detail,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6,'user',?7)",params![id(),person_id,fact.kind,fact.date_text,fact.place,fact.detail,fact.source_id]).map_err(|e|e.to_string())?;
        }
    }
    tx.execute(
        "UPDATE people SET preferred_birth_fact_id=NULL WHERE id=?1 AND preferred_birth_fact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts WHERE id=people.preferred_birth_fact_id AND person_id=?1 AND kind='birth')",
        [&person_id],
    ).map_err(|e| e.to_string())?;
    let summary = if exists {
        "Updated person"
    } else {
        "Added person"
    };
    change(
        &tx,
        summary,
        "manual",
        &[ChangeSubject::person(person_id.as_str(), input.name.trim())],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_person_from(&c, &person_id)
}

pub fn list_relationships(store: &Store, tree_id: &str) -> AppResult<Vec<Relationship>> {
    let c = store.tree(tree_id)?;
    list_relationships_from(&c)
}

pub fn list_intentional_disconnected_groups(store: &Store, tree_id: &str) -> AppResult<Vec<String>> {
    let c = store.tree(tree_id)?;
    let mut stmt = c.prepare("SELECT fingerprint FROM intentional_disconnected_groups ORDER BY acknowledged_at").map_err(|e| e.to_string())?;
    let groups = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(groups)
}

fn disconnected_group_fingerprint(member_ids: &[String]) -> AppResult<String> {
    if member_ids.len() < 2 { return Err("A separate branch needs at least two people".into()); }
    let mut ids = member_ids.to_vec();
    ids.sort(); ids.dedup();
    if ids.len() != member_ids.len() { return Err("A separate branch cannot contain the same person twice".into()); }
    Ok(ids.join("|"))
}

pub fn mark_disconnected_group_intentional(store: &Store, tree_id: &str, member_ids: &[String]) -> AppResult<()> {
    let fingerprint = disconnected_group_fingerprint(member_ids)?;
    let mut c = store.tree(tree_id)?; let tx = c.transaction().map_err(|e| e.to_string())?;
    for id in member_ids { let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM people WHERE id=?1)", [id], |row| row.get(0)).map_err(|e| e.to_string())?; if !exists { return Err("A selected person was not found in this tree".into()); } }
    tx.execute("INSERT INTO intentional_disconnected_groups(fingerprint,acknowledged_at) VALUES(?1,?2) ON CONFLICT(fingerprint) DO UPDATE SET acknowledged_at=excluded.acknowledged_at", params![fingerprint, now()]).map_err(|e| e.to_string())?;
    change(&tx, "Marked separate branch as intentional", "manual", &[ChangeSubject::context("branch", format!("{} people", member_ids.len()))], None, None)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn reopen_disconnected_group(store: &Store, tree_id: &str, member_ids: &[String]) -> AppResult<()> {
    let fingerprint = disconnected_group_fingerprint(member_ids)?;
    let mut c = store.tree(tree_id)?; let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM intentional_disconnected_groups WHERE fingerprint=?1", [&fingerprint]).map_err(|e| e.to_string())?;
    change(&tx, "Reopened separate branch for review", "manual", &[ChangeSubject::context("branch", format!("{} people", member_ids.len()))], None, None)?;
    tx.commit().map_err(|e| e.to_string())
}

fn list_relationships_from(c: &Connection) -> AppResult<Vec<Relationship>> {
    let mut stmt = c
        .prepare(
            "SELECT id,from_id,to_id,kind,provenance,source_id FROM relationships ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| {
            Ok(Relationship {
                id: r.get(0)?,
                from_id: r.get(1)?,
                to_id: r.get(2)?,
                kind: r.get(3)?,
                provenance: r.get(4)?,
                source_id: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn load_tree_core(store: &Store, tree_id: &str) -> AppResult<TreeCore> {
    let c = store.tree(tree_id)?;
    Ok(TreeCore {
        people: list_people_summaries_from(&c)?,
        relationships: list_relationships_from(&c)?,
        home_person_id: home_person_id_from(&c)?,
    })
}

pub fn add_relationship(
    store: &Store,
    tree_id: &str,
    from_id: String,
    to_id: String,
    kind: String,
    source_id: Option<String>,
) -> AppResult<Relationship> {
    if from_id == to_id {
        return Err("A person cannot be related to themself".into());
    }
    if ![
        "biological_parent",
        "adoptive_parent",
        "step_parent",
        "unknown_parent",
        "spouse",
        "partner",
    ]
    .contains(&kind.as_str())
    {
        return Err("Invalid relationship type".into());
    }
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let r = Relationship {
        id: id(),
        from_id,
        to_id,
        kind,
        provenance: "user".into(),
        source_id,
    };
    let from_name: String = tx
        .query_row("SELECT name FROM people WHERE id=?1", [&r.from_id], |row| {
            row.get(0)
        })
        .map_err(|_| "First person not found in this tree")?;
    let to_name: String = tx
        .query_row("SELECT name FROM people WHERE id=?1", [&r.to_id], |row| {
            row.get(0)
        })
        .map_err(|_| "Second person not found in this tree")?;
    tx.execute("INSERT INTO relationships(id,from_id,to_id,kind,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6)",params![r.id,r.from_id,r.to_id,r.kind,r.provenance,r.source_id]).map_err(|e|e.to_string())?;
    change(
        &tx,
        &format!("Added {} relationship", relationship_label(&r.kind)),
        "manual",
        &[
            ChangeSubject::person(r.from_id.as_str(), from_name),
            ChangeSubject::person(r.to_id.as_str(), to_name),
        ],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(r)
}

pub fn remove_relationship(store: &Store, tree_id: &str, relationship_id: &str) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let relationship: Option<(String, String, String)> = tx
        .query_row(
            "SELECT from_id,to_id,kind FROM relationships WHERE id=?1",
            [relationship_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (from_id, to_id, kind) = relationship.ok_or("Relationship not found")?;
    let from_name: String = tx
        .query_row("SELECT name FROM people WHERE id=?1", [&from_id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let to_name: String = tx
        .query_row("SELECT name FROM people WHERE id=?1", [&to_id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let count = tx
        .execute("DELETE FROM relationships WHERE id=?1", [relationship_id])
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("Relationship not found".into());
    }
    change(
        &tx,
        &format!("Removed {} relationship", relationship_label(&kind)),
        "manual",
        &[
            ChangeSubject::person(from_id, from_name),
            ChangeSubject::person(to_id, to_name),
        ],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn update_relationship(
    store: &Store,
    tree_id: &str,
    relationship_id: &str,
    from_id: &str,
    to_id: &str,
    kind: &str,
    source_id: Option<String>,
) -> AppResult<Relationship> {
    if from_id == to_id {
        return Err("A person cannot be related to themselves".into());
    }
    if ![
        "biological_parent",
        "adoptive_parent",
        "step_parent",
        "unknown_parent",
        "spouse",
        "partner",
    ]
    .contains(&kind)
    {
        return Err("Invalid relationship type".into());
    }
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let existing: Relationship = tx
        .query_row(
            "SELECT id,from_id,to_id,kind,provenance,source_id FROM relationships WHERE id=?1",
            [relationship_id],
            |r| {
                Ok(Relationship {
                    id: r.get(0)?,
                    from_id: r.get(1)?,
                    to_id: r.get(2)?,
                    kind: r.get(3)?,
                    provenance: r.get(4)?,
                    source_id: r.get(5)?,
                })
            },
        )
        .map_err(|_| "Relationship not found")?;
    tx.execute("UPDATE relationships SET from_id=?1,to_id=?2,kind=?3,source_id=?4,version=version+1 WHERE id=?5", params![from_id, to_id, kind, source_id, relationship_id]).map_err(|e| e.to_string())?;
    let updated = Relationship {
        id: relationship_id.into(),
        from_id: from_id.into(),
        to_id: to_id.into(),
        kind: kind.into(),
        provenance: existing.provenance,
        source_id,
    };
    let subjects = [from_id, to_id]
        .iter()
        .map(|person_id| person_subject(&tx, person_id))
        .collect::<AppResult<Vec<_>>>()?;
    change(&tx, "Updated relationship", "manual", &subjects, None, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(updated)
}

pub fn list_sources(store: &Store, tree_id: &str) -> AppResult<Vec<Source>> {
    let c = store.tree(tree_id)?;
    let mut stmt = c
        .prepare("SELECT id,title,url,citation,notes FROM sources ORDER BY title")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| {
            Ok(Source {
                id: r.get(0)?,
                title: r.get(1)?,
                url: r.get(2)?,
                citation: r.get(3)?,
                notes: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn add_source(
    store: &Store,
    tree_id: &str,
    title: String,
    url: String,
    citation: String,
    notes: String,
) -> AppResult<Source> {
    if title.trim().is_empty() {
        return Err("Enter a source title".into());
    }
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let source = Source {
        id: id(),
        title: title.trim().into(),
        url,
        citation,
        notes,
    };
    tx.execute(
        "INSERT INTO sources(id,title,url,citation,notes) VALUES(?1,?2,?3,?4,?5)",
        params![
            source.id,
            source.title,
            source.url,
            source.citation,
            source.notes
        ],
    )
    .map_err(|e| e.to_string())?;
    change(
        &tx,
        "Added source",
        "manual",
        &[ChangeSubject::context("source", source.title.as_str())],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(source)
}

pub fn list_attachments(
    store: &Store,
    tree_id: &str,
    person_id: &str,
) -> AppResult<Vec<Attachment>> {
    let c = store.tree(tree_id)?;
    let mut stmt=c.prepare("SELECT id,person_id,name,relative_path,content_type,created_at FROM attachments WHERE person_id=?1 ORDER BY created_at,id").map_err(|e|e.to_string())?;
    let out = stmt
        .query_map([person_id], |r| {
            Ok(Attachment {
                id: r.get(0)?,
                person_id: r.get(1)?,
                name: r.get(2)?,
                relative_path: r.get(3)?,
                content_type: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn add_attachment(
    store: &Store,
    tree_id: &str,
    person_id: &str,
    path: &str,
) -> AppResult<Attachment> {
    let source = PathBuf::from(path);
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    if !source.is_file() {
        return Err("Select a local file".into());
    }
    let dir = store.tree_dir(tree_id)?;
    let person = get_person(store, tree_id, person_id)?;
    let attachment_id = id();
    let relative_path = format!("media/{attachment_id}");
    let content_type = content_type_for_name(&name).to_string();
    fs::copy(source, dir.join(&relative_path)).map_err(|e| e.to_string())?;
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let a = Attachment {
        id: attachment_id,
        person_id: person_id.into(),
        name,
        relative_path,
        content_type,
        created_at: now(),
    };
    if let Err(e) = tx.execute(
        "INSERT INTO attachments(id,person_id,name,relative_path,content_type,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![a.id, a.person_id, a.name, a.relative_path, a.content_type, a.created_at],
    ) {
        let _ = fs::remove_file(dir.join(&a.relative_path));
        return Err(e.to_string());
    }
    change(
        &tx,
        &format!("Attached media: {}", a.name),
        "manual",
        &[ChangeSubject::person(
            person.id.as_str(),
            person.name.as_str(),
        )],
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(a)
}

pub fn content_type_for_name(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub fn list_portraits(
    store: &Store,
    tree_id: &str,
    person_ids: &[String],
) -> AppResult<Vec<Portrait>> {
    let tree_dir = store.tree_dir(tree_id)?;
    let c = store.tree(tree_id)?;
    if person_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = std::iter::repeat("?").take(person_ids.len()).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT id,person_id,name,relative_path,content_type,created_at FROM (
            SELECT id,person_id,name,relative_path,content_type,created_at,
                   ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at,id) AS position
            FROM attachments WHERE person_id IN ({placeholders})
              AND (content_type LIKE 'image/%' OR (content_type='' AND (lower(name) LIKE '%.jpg' OR lower(name) LIKE '%.jpeg' OR lower(name) LIKE '%.png' OR lower(name) LIKE '%.gif' OR lower(name) LIKE '%.webp' OR lower(name) LIKE '%.svg')))
         ) WHERE position=1"
    );
    let mut stmt = c.prepare(&query).map_err(|e| e.to_string())?;
    let attachments = stmt
            .query_map(rusqlite::params_from_iter(person_ids.iter()), |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    person_id: r.get(1)?,
                    name: r.get(2)?,
                    relative_path: r.get(3)?,
                    content_type: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    let mut portraits = Vec::new();
    const MAX_PORTRAIT_BYTES: u64 = 512 * 1024;
    for attachment in attachments {
        if !attachment.relative_path.starts_with("media/")
            || attachment.relative_path.contains("..")
        {
            continue;
        }
        let path = tree_dir.join(&attachment.relative_path);
        if fs::metadata(&path).map(|metadata| metadata.len() > MAX_PORTRAIT_BYTES).unwrap_or(true) {
            continue;
        }
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let content_type = if attachment.content_type.is_empty() {
            content_type_for_name(&attachment.name).to_string()
        } else {
            attachment.content_type
        };
        portraits.push(Portrait {
            person_id: attachment.person_id,
            attachment_id: attachment.id,
            data_url: format!("data:{};base64,{}", content_type, STANDARD.encode(bytes)),
        });
    }
    Ok(portraits)
}

pub fn list_changes(store: &Store, tree_id: &str) -> AppResult<Vec<Change>> {
    let c = store.tree(tree_id)?;
    let mut stmt=c.prepare("SELECT id,created_at,summary,kind,inverse_json,undone,subjects_json FROM changes ORDER BY created_at DESC").map_err(|e|e.to_string())?;
    let out = stmt
        .query_map([], |r| {
            Ok(Change {
                id: r.get(0)?,
                created_at: r.get(1)?,
                summary: r.get(2)?,
                kind: r.get(3)?,
                can_undo: r.get::<_, Option<String>>(4)?.is_some() && r.get::<_, i64>(5)? == 0,
                subjects: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn insert_change(
    c: &Connection,
    summary: &str,
    kind: &str,
    subjects: &[ChangeSubject],
    inverse: Option<&str>,
    forward: Option<&str>,
) -> AppResult<String> {
    change(c, summary, kind, subjects, inverse, forward)
}

pub fn delete_fact_for_suggestion(
    store: &Store,
    tree_id: &str,
    fact_id: &str,
    expected_revision: i64,
) -> AppResult<String> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if revision(&tx)? != expected_revision {
        return Err("Tree changed. Review this suggestion again.".into());
    }
    let fact=tx.query_row("SELECT id,person_id,kind,date_text,place,detail,provenance,source_id FROM facts WHERE id=?1",[fact_id],|r|Ok(Fact{id:r.get(0)?,person_id:r.get(1)?,kind:r.get(2)?,date_text:r.get(3)?,place:r.get(4)?,detail:r.get(5)?,provenance:r.get(6)?,source_id:r.get(7)?})).map_err(|e|e.to_string())?;
    let subject = person_subject(&tx, &fact.person_id)?;
    tx.execute("DELETE FROM facts WHERE id=?1", [fact_id])
        .map_err(|e| e.to_string())?;
    let inverse = serde_json::to_string(&fact).map_err(|e| e.to_string())?;
    let change_id = change(
        &tx,
        "Approved: remove conflicting fact",
        "suggestion",
        &[subject],
        Some(&inverse),
        Some(fact_id),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(change_id)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionInput {
    pub operation: String,
    pub fact_id: Option<String>,
    pub date_text: Option<String>,
    pub place: Option<String>,
    pub detail: Option<String>,
    pub survivor_id: Option<String>,
    pub duplicate_id: Option<String>,
    pub merge_plan: Option<MergePlanInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergePlanInput {
    pub primary_name: String,
    pub preferred_birth_fact_id: Option<String>,
    pub decisions: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BirthplaceAlternativeInput {
    pub fact_id: String,
    pub relation: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BirthplaceResolutionInput {
    pub preferred_fact_id: String,
    pub alternatives: Vec<BirthplaceAlternativeInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct BirthplaceResolutionSnapshot {
    kind: String,
    person_id: String,
    preferred_birth_fact_id: Option<String>,
    resolution: Option<StoredBirthplaceResolution>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct StoredBirthplaceResolution {
    fingerprint: String,
    preferred_fact_id: String,
    alternatives_json: String,
}

pub fn birthplace_reviewed(c: &Connection, person_id: &str, fingerprint: &str) -> AppResult<bool> {
    let saved: Option<String> = c
        .query_row(
            "SELECT fingerprint FROM birthplace_resolutions WHERE person_id=?1",
            [person_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(saved.as_deref() == Some(fingerprint))
}

pub fn resolve_birthplace_conflict(
    store: &Store,
    tree_id: &str,
    person_id: &str,
    fingerprint: &str,
    expected_revision: i64,
    input: BirthplaceResolutionInput,
) -> AppResult<String> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if revision(&tx)? != expected_revision {
        return Err("Tree changed. Review this birthplace variation again.".into());
    }
    let person = person_subject(&tx, person_id)?;
    let mut stmt = tx
        .prepare("SELECT id FROM facts WHERE person_id=?1 AND kind='birth' AND trim(place)<>''")
        .map_err(|e| e.to_string())?;
    let birth_ids = stmt
        .query_map([person_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    if !birth_ids.contains(&input.preferred_fact_id) {
        return Err(
            "Choose one of the recorded birthplaces as the preferred display place.".into(),
        );
    }
    let valid_relations = [
        "same_historical_place",
        "alternative_within_preferred",
        "preferred_within_alternative",
        "unresolved_conflict",
    ];
    let alternative_ids: std::collections::HashSet<_> = input
        .alternatives
        .iter()
        .map(|item| item.fact_id.as_str())
        .collect();
    if input.alternatives.len() != birth_ids.len().saturating_sub(1)
        || alternative_ids.len() != input.alternatives.len()
        || input.alternatives.iter().any(|item| {
            item.fact_id == input.preferred_fact_id
                || !birth_ids.contains(&item.fact_id)
                || !valid_relations.contains(&item.relation.as_str())
        })
    {
        return Err(
            "Classify every other recorded birthplace before marking this review complete.".into(),
        );
    }
    let previous_preferred: Option<String> = tx
        .query_row(
            "SELECT preferred_birth_fact_id FROM people WHERE id=?1",
            [person_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let previous_resolution: Option<StoredBirthplaceResolution> = tx.query_row(
        "SELECT fingerprint,preferred_fact_id,alternatives_json FROM birthplace_resolutions WHERE person_id=?1",
        [person_id],
        |r| Ok(StoredBirthplaceResolution { fingerprint: r.get(0)?, preferred_fact_id: r.get(1)?, alternatives_json: r.get(2)? }),
    ).optional().map_err(|e| e.to_string())?;
    let alternatives_json =
        serde_json::to_string(&input.alternatives).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE people SET preferred_birth_fact_id=?1 WHERE id=?2",
        params![input.preferred_fact_id, person_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO birthplace_resolutions(person_id,fingerprint,preferred_fact_id,alternatives_json,reviewed_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(person_id) DO UPDATE SET fingerprint=excluded.fingerprint,preferred_fact_id=excluded.preferred_fact_id,alternatives_json=excluded.alternatives_json,reviewed_at=excluded.reviewed_at",
        params![person_id, fingerprint, input.preferred_fact_id, alternatives_json, now()],
    ).map_err(|e| e.to_string())?;
    let before = BirthplaceResolutionSnapshot {
        kind: "birthplace_resolution".into(),
        person_id: person_id.into(),
        preferred_birth_fact_id: previous_preferred,
        resolution: previous_resolution,
    };
    let after = BirthplaceResolutionSnapshot {
        kind: "birthplace_resolution".into(),
        person_id: person_id.into(),
        preferred_birth_fact_id: Some(input.preferred_fact_id.clone()),
        resolution: Some(StoredBirthplaceResolution {
            fingerprint: fingerprint.into(),
            preferred_fact_id: input.preferred_fact_id.clone(),
            alternatives_json,
        }),
    };
    let change_id = change(
        &tx,
        "Reviewed birthplace variation",
        "review",
        &[person],
        Some(&serde_json::to_string(&before).map_err(|e| e.to_string())?),
        Some(&serde_json::to_string(&after).map_err(|e| e.to_string())?),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(change_id)
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeSnapshot {
    survivor: Person,
    duplicate: Person,
    relationships: Vec<Relationship>,
    attachments: Vec<Attachment>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeUndo {
    kind: String,
    after_revision: i64,
    snapshot: MergeSnapshot,
}

pub fn update_fact_for_suggestion(
    store: &Store,
    tree_id: &str,
    fact_id: &str,
    expected_revision: i64,
    date_text: String,
    place: String,
    detail: String,
) -> AppResult<String> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if revision(&tx)? != expected_revision {
        return Err("Tree changed. Review this suggestion again.".into());
    }
    let before = tx.query_row("SELECT id,person_id,kind,date_text,place,detail,provenance,source_id FROM facts WHERE id=?1", [fact_id], |r| Ok(Fact { id:r.get(0)?, person_id:r.get(1)?, kind:r.get(2)?, date_text:r.get(3)?, place:r.get(4)?, detail:r.get(5)?, provenance:r.get(6)?, source_id:r.get(7)? })).map_err(|e| e.to_string())?;
    let subject = person_subject(&tx, &before.person_id)?;
    let after = Fact {
        date_text,
        place,
        detail,
        ..before.clone()
    };
    tx.execute(
        "UPDATE facts SET date_text=?2,place=?3,detail=?4 WHERE id=?1",
        params![fact_id, after.date_text, after.place, after.detail],
    )
    .map_err(|e| e.to_string())?;
    let inverse = serde_json::to_string(&before).map_err(|e| e.to_string())?;
    let forward = serde_json::to_string(&after).map_err(|e| e.to_string())?;
    let change_id = change(
        &tx,
        "Approved: edit conflicting fact",
        "suggestion",
        &[subject],
        Some(&inverse),
        Some(&forward),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(change_id)
}

pub fn cached_issue_suggestion(
    c: &Connection,
    key: &str,
    fingerprint: &str,
    model: &str,
) -> AppResult<Option<String>> {
    c.query_row("SELECT suggestion_json FROM issue_suggestions WHERE issue_key=?1 AND fingerprint=?2 AND model=?3", params![key, fingerprint, model], |r| r.get(0))
        .optional().map_err(|e| e.to_string())
}

pub fn cache_issue_suggestion(
    c: &Connection,
    key: &str,
    fingerprint: &str,
    model: &str,
    suggestion_json: &str,
) -> AppResult<()> {
    c.execute("INSERT INTO issue_suggestions(issue_key,fingerprint,model,suggestion_json,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(issue_key,model) DO UPDATE SET fingerprint=excluded.fingerprint,suggestion_json=excluded.suggestion_json,created_at=excluded.created_at", params![key, fingerprint, model, suggestion_json, now()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn attachments_for_people(c: &Connection, ids: &[&str]) -> AppResult<Vec<Attachment>> {
    let mut out = vec![];
    for person_id in ids {
        let mut stmt = c
            .prepare("SELECT id,person_id,name,relative_path,content_type,created_at FROM attachments WHERE person_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([person_id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    person_id: r.get(1)?,
                    name: r.get(2)?,
                    relative_path: r.get(3)?,
                    content_type: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        out.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(out)
}

fn merge_fact_key(fact: &Fact) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{:?}",
        fact.kind, fact.date_text, fact.place, fact.detail, fact.source_id
    )
}

pub fn merge_people_for_suggestion(
    store: &Store,
    tree_id: &str,
    survivor_id: &str,
    duplicate_id: &str,
    expected_revision: i64,
    plan: MergePlanInput,
) -> AppResult<String> {
    if survivor_id == duplicate_id {
        return Err("Choose two different people to merge".into());
    }
    let mut c = store.tree(tree_id)?;
    let survivor = get_person_from(&c, survivor_id)?;
    let duplicate = get_person_from(&c, duplicate_id)?;
    let relationships = list_relationships(store, tree_id)?
        .into_iter()
        .filter(|r| {
            r.from_id == survivor_id
                || r.to_id == survivor_id
                || r.from_id == duplicate_id
                || r.to_id == duplicate_id
        })
        .collect::<Vec<_>>();
    let attachments = attachments_for_people(&c, &[survivor_id, duplicate_id])?;
    let snapshot = MergeSnapshot {
        survivor: survivor.clone(),
        duplicate: duplicate.clone(),
        relationships,
        attachments,
    };
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if revision(&tx)? != expected_revision {
        return Err("Tree changed. Review this merge again.".into());
    }
    let valid_primary_name = std::iter::once(&survivor.name)
        .chain(survivor.variants.iter())
        .chain(std::iter::once(&duplicate.name))
        .chain(duplicate.variants.iter())
        .any(|name| name == &plan.primary_name);
    if plan.primary_name.trim().is_empty()
        || !valid_primary_name
    {
        return Err("Choose a recorded name as the primary name.".into());
    }
    if plan
        .decisions
        .values()
        .any(|choice| !["left", "right", "both"].contains(&choice.as_str()))
    {
        return Err("A merge decision is invalid. Review the comparison again.".into());
    }
    if let Some(fact_id) = &plan.preferred_birth_fact_id {
        let birth_exists = survivor
            .facts
            .iter()
            .chain(duplicate.facts.iter())
            .any(|fact| fact.id == *fact_id && fact.kind == "birth");
        if !birth_exists {
            return Err("Choose a recorded birth fact as the preferred value.".into());
        }
    }

    let mut known = survivor
        .facts
        .iter()
        .map(merge_fact_key)
        .collect::<std::collections::HashSet<_>>();
    for fact in &duplicate.facts {
        if known.insert(merge_fact_key(fact)) {
            tx.execute(
                "UPDATE facts SET person_id=?1 WHERE id=?2",
                params![survivor_id, fact.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut variants = survivor.variants.clone();
    for value in std::iter::once(&duplicate.name).chain(duplicate.variants.iter()) {
        if !value.trim().is_empty()
            && !variants
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(value))
            && !survivor.name.eq_ignore_ascii_case(value)
        {
            variants.push(value.clone());
            tx.execute(
                "INSERT INTO names(id,person_id,value) VALUES(?1,?2,?3)",
                params![id(), survivor_id, value],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if !survivor.name.eq_ignore_ascii_case(&plan.primary_name)
        && !variants
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&survivor.name))
    {
        tx.execute(
            "INSERT INTO names(id,person_id,value) VALUES(?1,?2,?3)",
            params![id(), survivor_id, survivor.name],
        )
        .map_err(|e| e.to_string())?;
    }
    if !duplicate.notes.trim().is_empty() {
        let notes = if survivor.notes.trim().is_empty() {
            format!("Merged notes from {}:\n{}", duplicate.name, duplicate.notes)
        } else {
            format!(
                "{}\n\nMerged notes from {}:\n{}",
                survivor.notes, duplicate.name, duplicate.notes
            )
        };
        tx.execute(
            "UPDATE people SET name=?1,notes=?2,preferred_birth_fact_id=?3,version=version+1 WHERE id=?4",
            params![plan.primary_name, notes, plan.preferred_birth_fact_id, survivor_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE people SET name=?1,preferred_birth_fact_id=?2,version=version+1 WHERE id=?3",
            params![plan.primary_name, plan.preferred_birth_fact_id, survivor_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE attachments SET person_id=?1 WHERE person_id=?2",
        params![survivor_id, duplicate_id],
    )
    .map_err(|e| e.to_string())?;
    let all_relationships = snapshot.relationships.clone();
    for relationship in &all_relationships {
        let from_id = if relationship.from_id == duplicate_id {
            survivor_id
        } else {
            relationship.from_id.as_str()
        };
        let to_id = if relationship.to_id == duplicate_id {
            survivor_id
        } else {
            relationship.to_id.as_str()
        };
        if from_id == to_id {
            tx.execute("DELETE FROM relationships WHERE id=?1", [&relationship.id])
                .map_err(|e| e.to_string())?;
            continue;
        }
        let duplicate_link: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM relationships WHERE id<>?1 AND from_id=?2 AND to_id=?3 AND kind=?4 AND COALESCE(source_id,'')=COALESCE(?5,''))", params![relationship.id, from_id, to_id, relationship.kind, relationship.source_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if duplicate_link {
            tx.execute("DELETE FROM relationships WHERE id=?1", [&relationship.id])
                .map_err(|e| e.to_string())?;
        } else if relationship.from_id == duplicate_id || relationship.to_id == duplicate_id {
            tx.execute(
                "UPDATE relationships SET from_id=?1,to_id=?2 WHERE id=?3",
                params![from_id, to_id, relationship.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute("DELETE FROM people WHERE id=?1", [duplicate_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE meta SET value=?1 WHERE key='home_person_id' AND value=?2",
        params![survivor_id, duplicate_id],
    )
    .map_err(|e| e.to_string())?;
    let undo = MergeUndo {
        kind: "merge_people".into(),
        after_revision: expected_revision + 1,
        snapshot,
    };
    let inverse = serde_json::to_string(&undo).map_err(|e| e.to_string())?;
    let change_id = change(
        &tx,
        "Approved: merge likely duplicate people",
        "merge",
        &[
            ChangeSubject::person_with_role(survivor.id.as_str(), survivor.name.as_str(), "Kept"),
            ChangeSubject::person_with_role(
                duplicate.id.as_str(),
                duplicate.name.as_str(),
                "Merged",
            ),
        ],
        Some(&inverse),
        Some(&serde_json::to_string(&plan).map_err(|e| e.to_string())?),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(change_id)
}

fn restore_person_snapshot(tx: &rusqlite::Transaction<'_>, person: &Person) -> AppResult<()> {
    tx.execute(
        "INSERT INTO people(id,name,notes,living_status,sex,preferred_birth_fact_id,version) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            person.id,
            person.name,
            person.notes,
            person.living_status,
            person.sex,
            person.preferred_birth_fact_id,
            person.version
        ],
    )
    .map_err(|e| e.to_string())?;
    for variant in &person.variants {
        tx.execute(
            "INSERT INTO names(id,person_id,value) VALUES(?1,?2,?3)",
            params![id(), person.id, variant],
        )
        .map_err(|e| e.to_string())?;
    }
    for fact in &person.facts {
        tx.execute("INSERT INTO facts(id,person_id,kind,date_text,place,detail,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![fact.id, fact.person_id, fact.kind, fact.date_text, fact.place, fact.detail, fact.provenance, fact.source_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn undo_merge(tx: &rusqlite::Transaction<'_>, merge: MergeUndo) -> AppResult<()> {
    if revision(tx)? != merge.after_revision {
        return Err(
            "A later tree change prevents this merge from being undone automatically.".into(),
        );
    }
    tx.execute(
        "DELETE FROM people WHERE id=?1",
        [&merge.snapshot.survivor.id],
    )
    .map_err(|e| e.to_string())?;
    restore_person_snapshot(tx, &merge.snapshot.survivor)?;
    restore_person_snapshot(tx, &merge.snapshot.duplicate)?;
    for attachment in &merge.snapshot.attachments {
        tx.execute(
            "INSERT INTO attachments(id,person_id,name,relative_path,content_type,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                attachment.id,
                attachment.person_id,
                attachment.name,
                attachment.relative_path,
                attachment.content_type,
                attachment.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for relationship in &merge.snapshot.relationships {
        tx.execute("INSERT INTO relationships(id,from_id,to_id,kind,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6)", params![relationship.id, relationship.from_id, relationship.to_id, relationship.kind, relationship.provenance, relationship.source_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn undo_change(store: &Store, tree_id: &str, change_id: &str) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (inverse, forward, undone, subjects_json): (Option<String>, Option<String>, i64, String) =
        tx.query_row(
            "SELECT inverse_json,forward_json,undone,subjects_json FROM changes WHERE id=?1",
            [change_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    let subjects = serde_json::from_str::<Vec<ChangeSubject>>(&subjects_json).unwrap_or_default();
    if undone != 0 {
        return Err("Already undone".into());
    }
    let inverse_value = inverse.ok_or("This change cannot be undone")?;
    if let Ok(merge) = serde_json::from_str::<MergeUndo>(&inverse_value) {
        if merge.kind == "merge_people" {
            undo_merge(&tx, merge)?;
            tx.execute("UPDATE changes SET undone=1 WHERE id=?1", [change_id])
                .map_err(|e| e.to_string())?;
            change(&tx, "Undid approved merge", "undo", &subjects, None, None)?;
            return tx.commit().map_err(|e| e.to_string());
        }
    }
    if let Ok(snapshot) = serde_json::from_str::<BirthplaceResolutionSnapshot>(&inverse_value) {
        if snapshot.kind == "birthplace_resolution" {
            let after: BirthplaceResolutionSnapshot =
                serde_json::from_str(forward.as_deref().ok_or("Invalid undo data")?)
                    .map_err(|_| "Invalid undo data")?;
            let current_preferred: Option<String> = tx
                .query_row(
                    "SELECT preferred_birth_fact_id FROM people WHERE id=?1",
                    [&snapshot.person_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let current_resolution: Option<StoredBirthplaceResolution> = tx.query_row(
                "SELECT fingerprint,preferred_fact_id,alternatives_json FROM birthplace_resolutions WHERE person_id=?1",
                [&snapshot.person_id],
                |r| Ok(StoredBirthplaceResolution { fingerprint: r.get(0)?, preferred_fact_id: r.get(1)?, alternatives_json: r.get(2)? }),
            ).optional().map_err(|e| e.to_string())?;
            if current_preferred != after.preferred_birth_fact_id
                || current_resolution
                    .as_ref()
                    .map(|r| (&r.fingerprint, &r.preferred_fact_id, &r.alternatives_json))
                    != after
                        .resolution
                        .as_ref()
                        .map(|r| (&r.fingerprint, &r.preferred_fact_id, &r.alternatives_json))
            {
                return Err(
                    "This birthplace review was changed after approval. Review it manually.".into(),
                );
            }
            tx.execute(
                "UPDATE people SET preferred_birth_fact_id=?1 WHERE id=?2",
                params![snapshot.preferred_birth_fact_id, snapshot.person_id],
            )
            .map_err(|e| e.to_string())?;
            if let Some(resolution) = snapshot.resolution {
                tx.execute("INSERT INTO birthplace_resolutions(person_id,fingerprint,preferred_fact_id,alternatives_json,reviewed_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(person_id) DO UPDATE SET fingerprint=excluded.fingerprint,preferred_fact_id=excluded.preferred_fact_id,alternatives_json=excluded.alternatives_json,reviewed_at=excluded.reviewed_at", params![snapshot.person_id, resolution.fingerprint, resolution.preferred_fact_id, resolution.alternatives_json, now()]).map_err(|e| e.to_string())?;
            } else {
                tx.execute(
                    "DELETE FROM birthplace_resolutions WHERE person_id=?1",
                    [&snapshot.person_id],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute("UPDATE changes SET undone=1 WHERE id=?1", [change_id])
                .map_err(|e| e.to_string())?;
            change(
                &tx,
                "Undid birthplace review",
                "undo",
                &subjects,
                None,
                None,
            )?;
            return tx.commit().map_err(|e| e.to_string());
        }
    }
    let fact: Fact = serde_json::from_str(&inverse_value).map_err(|e| e.to_string())?;
    let forward_value = forward.ok_or("Invalid undo data")?;
    if forward_value.starts_with('{') {
        let expected: Fact =
            serde_json::from_str(&forward_value).map_err(|_| "Invalid undo data")?;
        let current = tx.query_row("SELECT id,person_id,kind,date_text,place,detail,provenance,source_id FROM facts WHERE id=?1", [&fact.id], |r| Ok(Fact { id:r.get(0)?, person_id:r.get(1)?, kind:r.get(2)?, date_text:r.get(3)?, place:r.get(4)?, detail:r.get(5)?, provenance:r.get(6)?, source_id:r.get(7)? })).optional().map_err(|e| e.to_string())?;
        if current
            .as_ref()
            .map(|value| serde_json::to_string(value).ok())
            != Some(serde_json::to_string(&expected).ok())
        {
            return Err("This fact was changed after approval. Review it manually.".into());
        }
        tx.execute(
            "UPDATE facts SET date_text=?2,place=?3,detail=?4 WHERE id=?1",
            params![fact.id, fact.date_text, fact.place, fact.detail],
        )
        .map_err(|e| e.to_string())?;
    } else {
        if forward_value != fact.id {
            return Err("Invalid undo data".into());
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM facts WHERE id=?1)",
                [&fact.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            return Err("This fact was changed after approval. Review it manually.".into());
        }
        tx.execute("INSERT INTO facts(id,person_id,kind,date_text,place,detail,provenance,source_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![fact.id,fact.person_id,fact.kind,fact.date_text,fact.place,fact.detail,fact.provenance,fact.source_id]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE changes SET undone=1 WHERE id=?1", [change_id])
        .map_err(|e| e.to_string())?;
    change(
        &tx,
        "Undid approved suggestion",
        "undo",
        &subjects,
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn issue_dismissed(c: &Connection, key: &str, fingerprint: &str) -> AppResult<bool> {
    let saved: Option<String> = c
        .query_row(
            "SELECT fingerprint FROM dismissed_issues WHERE issue_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(saved.as_deref() == Some(fingerprint))
}
pub fn issue_reviewed(c: &Connection, key: &str, fingerprint: &str) -> AppResult<bool> {
    let saved: Option<String> = c
        .query_row(
            "SELECT fingerprint FROM reviewed_issues WHERE issue_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(saved.as_deref() == Some(fingerprint))
}
pub fn mark_issue_reviewed(
    store: &Store,
    tree_id: &str,
    key: &str,
    fingerprint: &str,
    subjects: &[ChangeSubject],
) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO reviewed_issues(issue_key,fingerprint,reviewed_at) VALUES(?1,?2,?3) ON CONFLICT(issue_key) DO UPDATE SET fingerprint=excluded.fingerprint,reviewed_at=excluded.reviewed_at", params![key, fingerprint, now()]).map_err(|e| e.to_string())?;
    change(
        &tx,
        "Marked review item as reviewed",
        "manual",
        subjects,
        None,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())
}
pub fn dismiss_issue(
    store: &Store,
    tree_id: &str,
    key: &str,
    fingerprint: &str,
    subjects: &[ChangeSubject],
) -> AppResult<()> {
    let mut c = store.tree(tree_id)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO dismissed_issues(issue_key,fingerprint,dismissed_at) VALUES(?1,?2,?3) ON CONFLICT(issue_key) DO UPDATE SET fingerprint=excluded.fingerprint,dismissed_at=excluded.dismissed_at",params![key,fingerprint,now()]).map_err(|e|e.to_string())?;
    change(&tx, "Dismissed review item", "manual", subjects, None, None)?;
    tx.commit().map_err(|e| e.to_string())
}

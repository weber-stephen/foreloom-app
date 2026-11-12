use crate::db::{AppResult, Store};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet, HashSet}, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaceBucket {
    pub id: String, pub name: String, pub level: String, pub country_code: String,
    pub region_code: Option<String>, pub longitude: f64, pub latitude: f64,
    pub people_count: usize, pub person_ids: Vec<String>, pub event_kinds: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedPlace { pub place: String, pub people_count: usize, pub person_ids: Vec<String> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceMap {
    pub places: Vec<PlaceBucket>, pub countries: Vec<PlaceBucket>, pub unresolved: Vec<UnresolvedPlace>,
    pub mapped_people_count: usize, pub total_people_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GazetteerPlace {
    pub id: String, pub name: String, pub label: String, pub level: String,
    pub country_code: String, pub longitude: f64, pub latitude: f64,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaceCandidate {
    pub id: String, pub label: String, pub locality: String, pub county: String, pub region: String,
    pub country: String, pub country_code: String, pub latitude: f64, pub longitude: f64,
    pub source: String, pub confidence: String, pub rationale: String, pub alternatives: Vec<String>, pub requires_confirmation: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceResolutionSummary { pub unresolved: usize, pub ambiguous: usize, pub resolved: usize, pub reviewed: usize, pub skipped: usize }
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaceReviewFilter { #[serde(default)] pub confidence: String, #[serde(default)] pub country: String, #[serde(default)] pub event_type: String, #[serde(default)] pub reason: String, #[serde(default)] pub include_skipped: bool }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceReviewItem {
    pub fact_id: String, pub person_id: String, pub person_name: String, pub event_type: String, pub event_date: String,
    pub raw_place: String, pub family_context: String, pub reason: String, pub status: String, pub candidates: Vec<PlaceCandidate>,
}
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaceResolutionInput {
    pub fact_id: String, pub status: String, pub gazetteer_id: Option<String>, pub label: String, pub locality: String,
    pub county: String, pub region: String, pub country: String, pub country_code: String, pub latitude: Option<f64>,
    pub longitude: Option<f64>, pub source: String, pub confidence: String, pub rationale: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceMapFilter {
    #[serde(default)] pub event_kinds: Vec<String>,
    #[serde(default)] pub location_query: String,
    pub year_start: Option<i32>, pub year_end: Option<i32>,
    #[serde(default)] pub person_ids: Vec<String>,
}

/// Bundled, read-only reference data. Family facts remain only in tree SQLite files.
#[derive(Clone)]
pub struct Gazetteer { path: PathBuf }
impl Gazetteer {
    pub fn from_app(app: &AppHandle) -> AppResult<Self> {
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let candidates = [
            resource_dir.join("resources/gazetteer.sqlite"),
            resource_dir.join("gazetteer.sqlite"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/gazetteer.sqlite"),
        ];
        let path = candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
            "ForeLoom's offline place index is missing. Prepare the gazetteer before starting this build.".to_string()
        })?;
        Ok(Self { path })
    }
    fn connection(&self) -> AppResult<Connection> {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug)]
struct ResolvedPlace {
    id: String, name: String, level: String, country_code: String, region_code: Option<String>,
    longitude: f64, latitude: f64, hierarchy: String,
}
#[derive(Clone, Debug)]
struct StoredResolution { status: String, gazetteer_id: Option<String>, label: String, country_code: String, latitude: Option<f64>, longitude: Option<f64> }
fn normalize(value: &str) -> String {
    value.chars().flat_map(|c| if c.is_alphanumeric() || c.is_whitespace() { c.to_lowercase().collect::<Vec<_>>() } else { vec![' '] })
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
fn year_tokens(value: &str) -> Vec<i32> {
    let bytes = value.as_bytes(); let mut years = Vec::new();
    for i in 0..bytes.len().saturating_sub(3) {
        let end = i + 4;
        if !bytes[i..end].iter().all(u8::is_ascii_digit)
            || i.checked_sub(1).and_then(|n| bytes.get(n)).is_some_and(u8::is_ascii_digit)
            || bytes.get(end).is_some_and(u8::is_ascii_digit) { continue; }
        if let Ok(year) = value[i..end].parse() { years.push(year); }
    }
    years.sort_unstable(); years.dedup(); years
}
fn matches_year_filter(value: &str, start: Option<i32>, end: Option<i32>) -> bool {
    if start.is_none() && end.is_none() { return true; }
    year_tokens(value).into_iter().any(|year| start.map_or(true, |bound| year >= bound) && end.map_or(true, |bound| year <= bound))
}
fn row_to_place(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResolvedPlace> {
    Ok(ResolvedPlace {
        id: row.get(0)?, level: row.get(1)?, name: row.get(2)?, country_code: row.get(3)?,
        region_code: row.get(4)?, longitude: row.get(5)?, latitude: row.get(6)?, hierarchy: String::new(),
    })
}
fn place_by_id(c: &Connection, id: &str) -> AppResult<Option<ResolvedPlace>> {
    c.query_row("SELECT id,level,name,country_code,admin1_code,longitude,latitude FROM places WHERE id=?1", [id], row_to_place)
        .optional().map_err(|e| e.to_string())
}
fn named_places(c: &Connection, name: &str) -> AppResult<Vec<ResolvedPlace>> {
    let mut statement = c.prepare("SELECT DISTINCT p.id,p.level,p.name,p.country_code,p.admin1_code,p.longitude,p.latitude FROM place_names n JOIN places p ON p.id=n.place_id WHERE n.normalized=?1").map_err(|e| e.to_string())?;
    let places = statement.query_map([name], row_to_place).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(places)
}
fn hierarchy(c: &Connection, place: &ResolvedPlace) -> AppResult<String> {
    let mut labels = vec![place.name.clone()];
    let mut next = c.query_row("SELECT parent_id FROM places WHERE id=?1", [&place.id], |row| row.get::<_, Option<String>>(0)).optional().map_err(|e| e.to_string())?.flatten();
    let mut seen = HashSet::new();
    while let Some(id) = next {
        if !seen.insert(id.clone()) { break; }
        let parent = c.query_row("SELECT name,parent_id FROM places WHERE id=?1", [&id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).optional().map_err(|e| e.to_string())?;
        let Some((name, parent_id)) = parent else { break };
        if !labels.contains(&name) { labels.push(name); }
        next = parent_id;
    }
    Ok(labels.join(", "))
}
fn resolve(gazetteer: &Gazetteer, raw: &str, override_id: Option<&String>) -> AppResult<Option<ResolvedPlace>> {
    let c = gazetteer.connection()?;
    if let Some(id) = override_id {
        let canonical = if id.len() == 2 { format!("country:{id}") } else { id.clone() };
        if let Some(mut place) = place_by_id(&c, &canonical)? { place.hierarchy = hierarchy(&c, &place)?; return Ok(Some(place)); }
    }
    let components = raw.split(',').map(normalize).filter(|part| !part.is_empty()).collect::<Vec<_>>();
    if components.is_empty() { return Ok(None); }
    let mut matches = Vec::new(); let mut contexts = HashSet::new();
    for component in &components {
        for place in named_places(&c, component)? {
            if matches!(place.level.as_str(), "country" | "region" | "county") { contexts.insert(place.country_code.clone()); }
            matches.push(place);
        }
    }
    let weight = |level: &str| match level { "locality" => 4, "county" => 3, "region" => 2, "country" => 1, _ => 0 };
    let highest = matches.iter().map(|place| weight(&place.level)).max().unwrap_or(0);
    let mut candidates = matches.into_iter().filter(|place| weight(&place.level) == highest && (contexts.is_empty() || contexts.contains(&place.country_code))).collect::<Vec<_>>();
    candidates.sort_by(|a,b| a.id.cmp(&b.id)); candidates.dedup_by(|a,b| a.id == b.id);
    if candidates.len() != 1 { return Ok(None); }
    let mut place = candidates.pop().expect("candidate length checked");
    place.hierarchy = hierarchy(&c, &place)?;
    Ok(Some(place))
}
fn candidate_from_place(c: &Connection, mut place: ResolvedPlace, source: &str, confidence: &str, rationale: &str) -> AppResult<PlaceCandidate> {
    place.hierarchy = hierarchy(c, &place)?;
    let country = place.hierarchy.split(", ").last().unwrap_or("").to_string();
    Ok(PlaceCandidate { id: place.id.clone(), label: place.hierarchy, locality: if place.level == "locality" { place.name.clone() } else { String::new() }, county: if place.level == "county" { place.name.clone() } else { String::new() }, region: if place.level == "region" { place.name.clone() } else { String::new() }, country, country_code: place.country_code, latitude: place.latitude, longitude: place.longitude, source: source.into(), confidence: confidence.into(), rationale: rationale.into(), alternatives: vec![], requires_confirmation: confidence != "high" })
}
fn candidates(gazetteer: &Gazetteer, raw: &str) -> AppResult<Vec<PlaceCandidate>> {
    let c = gazetteer.connection()?;
    let components = raw.split(',').map(normalize).filter(|part| !part.is_empty()).collect::<Vec<_>>();
    let mut matches = Vec::new(); let mut contexts = HashSet::new();
    for component in &components { for place in named_places(&c, component)? { if matches!(place.level.as_str(), "country" | "region" | "county") { contexts.insert(place.country_code.clone()); } matches.push(place); } }
    let weight = |level: &str| match level { "locality" => 4, "county" => 3, "region" => 2, "country" => 1, _ => 0 };
    let highest = matches.iter().map(|place| weight(&place.level)).max().unwrap_or(0);
    matches.retain(|place| weight(&place.level) == highest && (contexts.is_empty() || contexts.contains(&place.country_code)));
    matches.sort_by(|a,b| a.id.cmp(&b.id)); matches.dedup_by(|a,b| a.id == b.id);
    let confidence = if matches.len() == 1 { "high" } else { "medium" };
    let rationale = if matches.len() == 1 { "Exact offline gazetteer match" } else { "Multiple offline gazetteer matches need context" };
    matches.into_iter().map(|place| candidate_from_place(&c, place, "offline", confidence, rationale)).collect()
}
fn stored_resolution(c: &Connection, fact_id: &str) -> AppResult<Option<StoredResolution>> {
    c.query_row("SELECT status,gazetteer_id,label,country_code,latitude,longitude FROM place_resolutions WHERE fact_id=?1", [fact_id], |r| Ok(StoredResolution { status:r.get(0)?, gazetteer_id:r.get(1)?, label:r.get(2)?, country_code:r.get(3)?, latitude:r.get(4)?, longitude:r.get(5)? })).optional().map_err(|e| e.to_string())
}
fn resolved_fact(c: &Connection, gazetteer: &Gazetteer, fact_id: &str, raw: &str) -> AppResult<Option<ResolvedPlace>> {
    if let Some(stored) = stored_resolution(c, fact_id)? {
        if stored.status != "approved" { return Ok(None); }
        if let Some(id) = stored.gazetteer_id { return resolve(gazetteer, raw, Some(&id)); }
        if let (Some(latitude), Some(longitude)) = (stored.latitude, stored.longitude) { return Ok(Some(ResolvedPlace { id: format!("manual:{fact_id}"), name: if stored.label.is_empty() { raw.into() } else { stored.label }, level:"locality".into(), country_code: stored.country_code, region_code: None, longitude, latitude, hierarchy: String::new() })); }
    }
    resolve(gazetteer, raw, None)
}
pub fn search(gazetteer: &Gazetteer, query: &str) -> AppResult<Vec<GazetteerPlace>> {
    let query = normalize(query); if query.len() < 2 { return Ok(Vec::new()); }
    let c = gazetteer.connection()?;
    let mut statement = c.prepare("SELECT DISTINCT p.id,p.level,p.name,p.country_code,p.admin1_code,p.longitude,p.latitude FROM place_names n JOIN places p ON p.id=n.place_id WHERE n.normalized LIKE ?1 || '%' ORDER BY n.normalized=?1 DESC, p.level='locality' DESC, p.name LIMIT 12").map_err(|e| e.to_string())?;
    let places = statement.query_map([query], row_to_place).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    places.into_iter().map(|place| {
        let label = hierarchy(&c, &place)?;
        Ok(GazetteerPlace { id: place.id, name: place.name, label, level: place.level, country_code: place.country_code, longitude: place.longitude, latitude: place.latitude })
    }).collect()
}
pub fn save_override(store: &Store, gazetteer: &Gazetteer, tree_id: &str, raw_place: &str, gazetteer_id: &str) -> AppResult<()> {
    if resolve(gazetteer, raw_place, Some(&gazetteer_id.to_string()))?.is_none() { return Err("Unknown map place".into()); }
    store.tree(tree_id)?.execute("INSERT INTO place_overrides(raw_place_key,gazetteer_id) VALUES(?1,?2) ON CONFLICT(raw_place_key) DO UPDATE SET gazetteer_id=excluded.gazetteer_id", params![normalize(raw_place), gazetteer_id]).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn clear_override(store: &Store, tree_id: &str, raw_place: &str) -> AppResult<()> {
    store.tree(tree_id)?.execute("DELETE FROM place_overrides WHERE raw_place_key=?1", [normalize(raw_place)]).map_err(|e| e.to_string())?; Ok(())
}
pub fn review_summary(store: &Store, gazetteer: &Gazetteer, tree_id: &str) -> AppResult<PlaceResolutionSummary> {
    let c = store.tree(tree_id)?; let mut unresolved=0; let mut ambiguous=0; let mut resolved=0; let mut reviewed=0; let mut skipped=0;
    let mut stmt = c.prepare("SELECT id,place FROM facts WHERE trim(place)<>''").map_err(|e| e.to_string())?;
    for row in stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e| e.to_string())? {
        let (fact_id, raw) = row.map_err(|e| e.to_string())?;
        if let Some(record) = stored_resolution(&c, &fact_id)? { if record.status == "approved" { resolved+=1; reviewed+=1; continue } if record.status == "permanently_unresolved" { unresolved+=1; reviewed+=1; continue } if record.status == "skipped" { skipped+=1; } }
        let found=candidates(gazetteer,&raw)?; if found.is_empty(){unresolved+=1}else if found.len()>1{ambiguous+=1}else{resolved+=1}
    }
    Ok(PlaceResolutionSummary{unresolved,ambiguous,resolved,reviewed,skipped})
}
pub fn review_items(store: &Store, gazetteer: &Gazetteer, tree_id: &str, filter: PlaceReviewFilter) -> AppResult<Vec<PlaceReviewItem>> {
    let c=store.tree(tree_id)?; let mut result=Vec::new();
    let mut stmt=c.prepare("SELECT f.id,f.person_id,p.name,f.kind,f.date_text,f.place FROM facts f JOIN people p ON p.id=f.person_id WHERE trim(f.place)<>'' ORDER BY p.name,f.date_text,f.id").map_err(|e|e.to_string())?;
    for row in stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?))).map_err(|e|e.to_string())? {
        let (fact_id,person_id,person_name,event_type,event_date,raw_place)=row.map_err(|e|e.to_string())?;
        if !filter.event_type.is_empty() && filter.event_type != event_type { continue }
        let record=stored_resolution(&c,&fact_id)?; let status=record.as_ref().map(|r|r.status.clone()).unwrap_or_else(||"pending".into());
        if status=="approved" || status=="permanently_unresolved" || (!filter.include_skipped && status=="skipped") { continue }
        let found=candidates(gazetteer,&raw_place)?; let reason=if found.is_empty(){"no_match"}else if found.len()>1{"multiple_matches"}else{"incomplete_context"};
        if !filter.reason.is_empty() && filter.reason != reason { continue }
        if !filter.confidence.is_empty() && !found.iter().any(|x|x.confidence==filter.confidence) { continue }
        if !filter.country.is_empty() && !found.iter().any(|x|x.country_code==filter.country) { continue }
        let family_context: String=c.query_row("SELECT group_concat(name, ', ') FROM (SELECT p2.name AS name FROM relationships r JOIN people p2 ON p2.id=CASE WHEN r.from_id=?1 THEN r.to_id ELSE r.from_id END WHERE r.from_id=?1 OR r.to_id=?1 LIMIT 3)",[&person_id],|r|r.get::<_,Option<String>>(0)).optional().map_err(|e|e.to_string())?.flatten().unwrap_or_default();
        result.push(PlaceReviewItem{fact_id,person_id,person_name,event_type,event_date,raw_place,family_context,reason:reason.into(),status,candidates:found});
    }
    Ok(result)
}
pub fn save_resolution(store: &Store, tree_id: &str, input: PlaceResolutionInput) -> AppResult<()> {
    if !["approved","skipped","permanently_unresolved"].contains(&input.status.as_str()) { return Err("Invalid place review status".into()) }
    if input.status=="approved" && (input.latitude.is_none() || input.longitude.is_none()) { return Err("Choose a map location before approving this place".into()) }
    let c=store.tree(tree_id)?;
    let exists: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM facts WHERE id=?1)",[&input.fact_id],|r|r.get(0)).map_err(|e|e.to_string())?; if !exists{return Err("Place event no longer exists".into())}
    c.execute("INSERT INTO place_resolutions(fact_id,status,gazetteer_id,label,locality,county,region,country,country_code,latitude,longitude,source,confidence,rationale,context_key,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'',?15) ON CONFLICT(fact_id) DO UPDATE SET status=excluded.status,gazetteer_id=excluded.gazetteer_id,label=excluded.label,locality=excluded.locality,county=excluded.county,region=excluded.region,country=excluded.country,country_code=excluded.country_code,latitude=excluded.latitude,longitude=excluded.longitude,source=excluded.source,confidence=excluded.confidence,rationale=excluded.rationale,created_at=excluded.created_at",params![input.fact_id,input.status,input.gazetteer_id,input.label,input.locality,input.county,input.region,input.country,input.country_code,input.latitude,input.longitude,input.source,input.confidence,input.rationale,crate::db::now()]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn revert_resolution(store:&Store,tree_id:&str,fact_id:&str)->AppResult<()> { store.tree(tree_id)?.execute("DELETE FROM place_resolutions WHERE fact_id=?1",[fact_id]).map_err(|e|e.to_string())?; Ok(()) }
fn bucket(place: &ResolvedPlace, people: BTreeSet<String>, kinds: BTreeSet<String>) -> PlaceBucket {
    PlaceBucket { id: place.id.clone(), name: place.name.clone(), level: place.level.clone(), country_code: place.country_code.clone(), region_code: place.region_code.clone(), longitude: place.longitude, latitude: place.latitude, people_count: people.len(), person_ids: people.into_iter().collect(), event_kinds: kinds.into_iter().collect() }
}
pub fn map(store: &Store, gazetteer: &Gazetteer, tree_id: &str, filter: PlaceMapFilter) -> AppResult<PlaceMap> {
    let c = store.tree(tree_id)?;
    let allowed = filter.person_ids.iter().collect::<HashSet<_>>();
    let mut areas: BTreeMap<String,(ResolvedPlace,BTreeSet<String>,BTreeSet<String>)> = BTreeMap::new();
    let mut country_people: BTreeMap<String,BTreeSet<String>> = BTreeMap::new();
    let mut country_kinds: BTreeMap<String,BTreeSet<String>> = BTreeMap::new();
    let mut unresolved: BTreeMap<String,BTreeSet<String>> = BTreeMap::new(); let mut total = BTreeSet::new();
    let mut statement = c.prepare("SELECT id,person_id,kind,place,date_text FROM facts WHERE trim(place)<>''").map_err(|e| e.to_string())?;
    for row in statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?))).map_err(|e| e.to_string())? {
        let (fact_id, person_id, kind, raw, date) = row.map_err(|e| e.to_string())?;
        if (!filter.event_kinds.is_empty() && !filter.event_kinds.contains(&kind)) || (!allowed.is_empty() && !allowed.contains(&person_id)) || !matches_year_filter(&date, filter.year_start, filter.year_end) { continue; }
        let resolved = resolved_fact(&c, gazetteer, &fact_id, &raw)?;
        let query = normalize(&filter.location_query);
        if !query.is_empty() && !normalize(&raw).contains(&query) && !resolved.as_ref().is_some_and(|place| normalize(&place.hierarchy).contains(&query)) { continue; }
        total.insert(person_id.clone());
        if let Some(place) = resolved {
            let entry = areas.entry(place.id.clone()).or_insert_with(|| (place.clone(),BTreeSet::new(),BTreeSet::new()));
            entry.1.insert(person_id.clone()); entry.2.insert(kind.clone());
            country_people.entry(place.country_code.clone()).or_default().insert(person_id);
            country_kinds.entry(place.country_code.clone()).or_default().insert(kind);
        } else { unresolved.entry(raw).or_default().insert(person_id); }
    }
    let mut places = areas.into_values().map(|(place,people,kinds)| bucket(&place,people,kinds)).collect::<Vec<_>>();
    places.sort_by(|a,b| b.people_count.cmp(&a.people_count).then_with(|| a.name.cmp(&b.name)));
    let mut countries = Vec::new();
    for (code, people) in country_people {
        let id = format!("country:{code}");
        if let Some(place) = resolve(gazetteer, &code, Some(&id))? { countries.push(bucket(&place,people,country_kinds.remove(&code).unwrap_or_default())); }
    }
    countries.sort_by(|a,b| b.people_count.cmp(&a.people_count).then_with(|| a.name.cmp(&b.name)));
    let mapped = countries.iter().flat_map(|place| place.person_ids.iter().cloned()).collect::<BTreeSet<_>>().len();
    Ok(PlaceMap { places, countries, unresolved: unresolved.into_iter().map(|(place,people)| UnresolvedPlace { place, people_count: people.len(), person_ids: people.into_iter().collect() }).collect(), mapped_people_count: mapped, total_people_count: total.len() })
}

#[cfg(test)]
mod tests {
    use super::*; use std::fs;
    fn fixture() -> Gazetteer {
        let path = std::env::temp_dir().join(format!("kinfolk-gazetteer-{}.sqlite", uuid::Uuid::new_v4()));
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE places(id TEXT PRIMARY KEY,level TEXT,parent_id TEXT,country_code TEXT,admin1_code TEXT,admin2_code TEXT,name TEXT,latitude REAL,longitude REAL);CREATE TABLE place_names(normalized TEXT,place_id TEXT);").unwrap();
        for (id,level,parent,country,admin,name,lat,lon) in [("country:GB","country",None,"GB",None,"United Kingdom",54.0,-2.0),("region:GB.SCT","region",Some("country:GB"),"GB",Some("SCT"),"Scotland",56.0,-4.0),("locality:edinburgh","locality",Some("region:GB.SCT"),"GB",Some("SCT"),"Edinburgh",55.95,-3.19),("country:US","country",None,"US",None,"United States",39.0,-98.0),("locality:edinburgh-us","locality",Some("country:US"),"US",Some("IN"),"Edinburgh",39.35,-85.96)] {
            c.execute("INSERT INTO places VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8)",params![id,level,parent,country,admin,name,lat,lon]).unwrap();
            c.execute("INSERT INTO place_names VALUES(?1,?2)",params![normalize(name),id]).unwrap();
        } Gazetteer { path }
    }
    #[test] fn exact_locality_requires_context_when_ambiguous() {
        let gazetteer=fixture(); assert!(resolve(&gazetteer,"Edinburgh",None).unwrap().is_none());
        assert_eq!(resolve(&gazetteer,"Edinburgh, Scotland",None).unwrap().unwrap().id,"locality:edinburgh");
        assert_eq!(candidates(&gazetteer,"Edinburgh").unwrap().len(),2);
        assert_eq!(candidates(&gazetteer,"Edinburgh, Scotland").unwrap()[0].confidence,"high");
        fs::remove_file(gazetteer.path).unwrap();
    }
    #[test] fn date_filter_handles_uncertain_and_outside_years() {
        assert!(matches_year_filter("about 1902",Some(1900),Some(1904)));
        assert!(!matches_year_filter("1899",Some(1900),Some(1904)));
        assert!(!matches_year_filter("unknown",Some(1900),None));
    }
}

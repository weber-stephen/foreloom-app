use crate::db::{self, AppResult, Person, Relationship, Store};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub kind: String,
    pub category: String,
    pub severity: String,
    pub fix_effort: String,
    pub title: String,
    pub explanation: String,
    pub evidence: Vec<String>,
    pub confidence: String,
    pub person_ids: Vec<String>,
    pub proposed_fact_id: Option<String>,
    pub merge_candidate: Option<MergeCandidate>,
    pub revision: i64,
    pub fingerprint: String,
    pub dismissed: bool,
    pub reviewed: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergeCandidate {
    pub survivor_id: String,
    pub duplicate_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DateBounds {
    earliest: Option<i32>,
    latest: Option<i32>,
    interpretation: String,
}

fn first_year(text: &str) -> Option<i32> {
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(3) {
        if bytes[i..i + 4].iter().all(|b| b.is_ascii_digit()) {
            if let Ok(slice) = std::str::from_utf8(&bytes[i..i + 4]) {
                if let Ok(y) = slice.parse::<i32>() {
                    if (100..=2200).contains(&y) {
                        return Some(y);
                    }
                }
            }
        }
    }
    None
}

fn dual_year(text: &str) -> Option<(i32, i32)> {
    let bytes = text.as_bytes();
    if bytes.len() < 6 {
        return None;
    }
    for i in 0..=bytes.len() - 6 {
        if bytes[i..i + 4].iter().all(|b| b.is_ascii_digit()) && bytes.get(i + 4) == Some(&b'/') {
            let end_len = if bytes.get(i + 5).is_some_and(u8::is_ascii_digit)
                && bytes.get(i + 6).is_some_and(u8::is_ascii_digit)
            {
                2
            } else {
                1
            };
            if bytes[i + 5..i + 5 + end_len]
                .iter()
                .all(|b| b.is_ascii_digit())
            {
                let start = std::str::from_utf8(&bytes[i..i + 4])
                    .ok()?
                    .parse::<i32>()
                    .ok()?;
                let suffix = std::str::from_utf8(&bytes[i + 5..i + 5 + end_len])
                    .ok()?
                    .parse::<i32>()
                    .ok()?;
                let magnitude = 10_i32.pow(end_len as u32);
                let end = (start / magnitude) * magnitude + suffix;
                return Some((start, if end < start { end + magnitude } else { end }));
            }
        }
    }
    None
}

/// Parses the date expression only far enough to make conservative chronology comparisons.
/// The stored GEDCOM text is never normalized or replaced by this interpretation.
fn bounds(text: &str) -> Option<DateBounds> {
    let value = text.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("unknown") {
        return None;
    }
    let upper = value.to_ascii_uppercase();
    if upper.starts_with("BET ") || upper.starts_with("BETWEEN ") || upper.starts_with("FROM ") {
        let separator = if upper.starts_with("FROM ") {
            " TO "
        } else {
            " AND "
        };
        if let Some((start, end)) = upper.split_once(separator) {
            let start = bounds(
                start
                    .trim_start_matches("BET ")
                    .trim_start_matches("BETWEEN ")
                    .trim_start_matches("FROM "),
            )?;
            let end = bounds(end)?;
            return Some(DateBounds {
                earliest: start.earliest,
                latest: end.latest,
                interpretation: format!(
                    "range interpreted as {}–{}",
                    start.interpretation, end.interpretation
                ),
            });
        }
    }
    let (year, dual) = match dual_year(value) {
        Some((start, end)) => (start, Some(end)),
        None => (first_year(value)?, None),
    };
    if upper.starts_with("BEF ") || upper.starts_with("BEFORE ") {
        Some(DateBounds {
            earliest: None,
            latest: Some(year - 1),
            interpretation: format!("before {year}"),
        })
    } else if upper.starts_with("AFT ") || upper.starts_with("AFTER ") {
        Some(DateBounds {
            earliest: Some(year + 1),
            latest: None,
            interpretation: format!("after {year}"),
        })
    } else if upper.starts_with("ABT ")
        || upper.starts_with("ABOUT ")
        || upper.starts_with("CIRCA ")
        || upper.starts_with("CAL ")
        || upper.starts_with("EST ")
        || upper.starts_with("CA ")
        || upper.starts_with("CA. ")
    {
        Some(DateBounds {
            earliest: Some(year - 5),
            latest: Some(dual.unwrap_or(year) + 5),
            interpretation: format!("estimated around {year}"),
        })
    } else if let Some(end) = dual {
        Some(DateBounds {
            earliest: Some(year),
            latest: Some(end),
            interpretation: format!("historical dual year {year}/{:02}", end % 100),
        })
    } else {
        Some(DateBounds {
            earliest: Some(year),
            latest: Some(year),
            interpretation: format!("recorded year {year}"),
        })
    }
}
fn year(text: &str) -> Option<i32> {
    bounds(text).and_then(|range| range.earliest)
}
fn birth(p: &Person) -> Option<(&crate::db::Fact, i32)> {
    p.facts.iter().find_map(|f| {
        if f.kind == "birth" {
            bounds(&f.date_text).and_then(|range| range.earliest.map(|y| (f, y)))
        } else {
            None
        }
    })
}
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}
fn push(out: &mut Vec<Issue>, c: &rusqlite::Connection, mut issue: Issue) -> AppResult<()> {
    issue.dismissed = db::issue_dismissed(c, &issue.key, &issue.fingerprint)?;
    issue.reviewed = db::issue_reviewed(c, &issue.key, &issue.fingerprint)?;
    if issue.kind == "birthplace" {
        issue.reviewed |= db::birthplace_reviewed(c, &issue.person_ids[0], &issue.fingerprint)?;
    }
    out.push(issue);
    Ok(())
}
fn issue(
    key: String,
    kind: &str,
    title: String,
    explanation: &str,
    evidence: Vec<String>,
    confidence: &str,
    person_ids: Vec<String>,
    proposed_fact_id: Option<String>,
    revision: i64,
    fingerprint: String,
) -> Issue {
    let (category, severity, fix_effort) = match kind {
        "chronology" => ("chronology", "high", "quick"),
        "duplicate" => ("duplicates", "medium", "manual"),
        "birthplace" => ("place_conflicts", "medium", "assisted"),
        "connection" => (
            "relationships",
            if title.contains("Circular") {
                "high"
            } else {
                "medium"
            },
            "manual",
        ),
        "unlinked" => ("disconnected", "low", "manual"),
        _ => ("other", "low", "manual"),
    };
    Issue {
        key,
        kind: kind.into(),
        category: category.into(),
        severity: severity.into(),
        fix_effort: fix_effort.into(),
        title,
        explanation: explanation.into(),
        evidence,
        confidence: confidence.into(),
        person_ids,
        proposed_fact_id,
        merge_candidate: None,
        revision,
        fingerprint,
        dismissed: false,
        reviewed: false,
    }
}

fn birthplace_fingerprint(births: &[&crate::db::Fact]) -> String {
    let mut values: Vec<_> = births
        .iter()
        .filter(|fact| !fact.place.trim().is_empty())
        .map(|fact| format!("{}:{}:{}", fact.id, fact.date_text, normalize(&fact.place)))
        .collect();
    values.sort();
    values.join("|")
}

fn matching_names(a: &Person, b: &Person) -> bool {
    normalize(&a.name) == normalize(&b.name)
        || a.variants
            .iter()
            .any(|name| normalize(name) == normalize(&b.name))
        || b.variants
            .iter()
            .any(|name| normalize(name) == normalize(&a.name))
}

fn related_ids(person_id: &str, relationships: &[Relationship], kind: &str) -> HashSet<String> {
    match kind {
        "parent" => relationships
            .iter()
            .filter(|r| r.kind.ends_with("_parent") && r.to_id == person_id)
            .map(|r| r.from_id.clone())
            .collect(),
        "child" => relationships
            .iter()
            .filter(|r| r.kind.ends_with("_parent") && r.from_id == person_id)
            .map(|r| r.to_id.clone())
            .collect(),
        "partner" => relationships
            .iter()
            .filter(|r| {
                matches!(r.kind.as_str(), "spouse" | "partner")
                    && (r.from_id == person_id || r.to_id == person_id)
            })
            .map(|r| {
                if r.from_id == person_id {
                    r.to_id.clone()
                } else {
                    r.from_id.clone()
                }
            })
            .collect(),
        "sibling" => {
            let parents = related_ids(person_id, relationships, "parent");
            relationships
                .iter()
                .filter(|r| {
                    r.kind.ends_with("_parent")
                        && parents.contains(&r.from_id)
                        && r.to_id != person_id
                })
                .map(|r| r.to_id.clone())
                .collect()
        }
        _ => HashSet::new(),
    }
}

fn person_label(person: &Person) -> String {
    let life = |kind: &str| {
        person
            .facts
            .iter()
            .find(|fact| fact.kind == kind)
            .map(|fact| fact.date_text.as_str())
            .filter(|date| !date.trim().is_empty())
    };
    match (life("birth"), life("death")) {
        (Some(b), Some(d)) => format!("{} (b. {}; d. {})", person.name, b, d),
        (Some(b), None) => format!("{} (b. {})", person.name, b),
        (None, Some(d)) => format!("{} (d. {})", person.name, d),
        _ => person.name.clone(),
    }
}

fn relationship_evidence(ids: &HashSet<String>, people: &HashMap<&str, &Person>) -> String {
    let mut labels: Vec<_> = ids
        .iter()
        .map(|id| {
            people
                .get(id.as_str())
                .map(|person| person_label(person))
                .unwrap_or_else(|| "Unknown person".into())
        })
        .collect();
    labels.sort();
    labels.join("; ")
}

fn fact_places(person: &Person, kind: &str) -> HashSet<String> {
    person
        .facts
        .iter()
        .filter(|fact| fact.kind == kind)
        .map(|fact| normalize(&fact.place))
        .filter(|place| !place.is_empty())
        .collect()
}

fn has_direct_link(a: &Person, b: &Person, relationships: &[Relationship]) -> bool {
    relationships
        .iter()
        .any(|r| (r.from_id == a.id && r.to_id == b.id) || (r.from_id == b.id && r.to_id == a.id))
}

fn strong_duplicate(a: &Person, b: &Person, relationships: &[Relationship]) -> bool {
    let names_match = normalize(&a.name) == normalize(&b.name)
        || a.variants
            .iter()
            .any(|name| normalize(name) == normalize(&b.name))
        || b.variants
            .iter()
            .any(|name| normalize(name) == normalize(&a.name));
    let birth_match =
        matches!((birth(a), birth(b)), (Some((_, ay)), Some((_, by))) if (ay - by).abs() <= 1);
    let sex_conflict =
        !a.sex.trim().is_empty() && !b.sex.trim().is_empty() && !a.sex.eq_ignore_ascii_case(&b.sex);
    let death_year = |person: &Person| {
        person
            .facts
            .iter()
            .find(|fact| fact.kind == "death")
            .and_then(|fact| year(&fact.date_text))
    };
    let death_conflict =
        matches!((death_year(a), death_year(b)), (Some(ay), Some(by)) if (ay - by).abs() > 1);
    let a_parents = related_ids(&a.id, relationships, "parent");
    let b_parents = related_ids(&b.id, relationships, "parent");
    let shared_family = ["parent", "child", "partner", "sibling"]
        .iter()
        .any(|kind| {
            !related_ids(&a.id, relationships, kind).is_disjoint(&related_ids(
                &b.id,
                relationships,
                kind,
            ))
        });
    let parent_conflict =
        !a_parents.is_empty() && !b_parents.is_empty() && a_parents.is_disjoint(&b_parents);
    names_match
        && birth_match
        && shared_family
        && !sex_conflict
        && !death_conflict
        && !parent_conflict
        && !has_direct_link(a, b, relationships)
}

fn suggested_survivor(a: &Person, b: &Person) -> String {
    let score = |person: &Person| {
        person.facts.len() + person.variants.len() + usize::from(!person.notes.trim().is_empty())
    };
    if score(a) >= score(b) {
        a.id.clone()
    } else {
        b.id.clone()
    }
}

pub fn list_issues(store: &Store, tree_id: &str) -> AppResult<Vec<Issue>> {
    let c = store.tree(tree_id)?;
    let rev = db::revision(&c)?;
    let people = db::list_people(store, tree_id, None)?;
    let relationships = db::list_relationships(store, tree_id)?;
    let by_id: HashMap<&str, &Person> = people.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut out = vec![];

    for p in &people {
        let births: Vec<_> = p.facts.iter().filter(|f| f.kind == "birth").collect();
        let deaths: Vec<_> = p.facts.iter().filter(|f| f.kind == "death").collect();
        for b in &births {
            for d in &deaths {
                if let (
                    Some(DateBounds {
                        earliest: Some(by), ..
                    }),
                    Some(DateBounds {
                        latest: Some(dy), ..
                    }),
                ) = (bounds(&b.date_text), bounds(&d.date_text))
                {
                    if dy < by {
                        let key = format!("chronology:{}:{}", b.id, d.id);
                        let fingerprint = format!("{}:{}:{}", p.version, b.date_text, d.date_text);
                        let birth_interpretation = bounds(&b.date_text).unwrap().interpretation;
                        let death_interpretation = bounds(&d.date_text).unwrap().interpretation;
                        push(&mut out,&c,issue(key,"chronology",format!("{}: death before birth",p.name),"The deterministic date ranges do not overlap: death is entirely before birth. Keep the original date text and compare the cited records before editing either fact.",vec![format!("Birth: {} ({})",b.date_text, birth_interpretation),format!("Death: {} ({})",d.date_text, death_interpretation)],"high",vec![p.id.clone()],Some(d.id.clone()),rev,fingerprint))?;
                    }
                }
            }
        }
        let places: HashSet<_> = births
            .iter()
            .map(|f| normalize(&f.place))
            .filter(|s| !s.is_empty())
            .collect();
        if places.len() > 1 {
            let key = format!("birthplace:{}", p.id);
            let evidence = births
                .iter()
                .filter(|f| !f.place.is_empty())
                .map(|f| {
                    if f.date_text.trim().is_empty() {
                        format!("Birthplace: {}", f.place)
                    } else {
                        format!("Birthplace: {} · {}", f.place, f.date_text)
                    }
                })
                .collect();
            push(&mut out,&c,issue(key,"birthplace",format!("{}: possible birthplace variation",p.name),"Multiple birth facts name different places. Historical place names and changing boundaries may explain the variation; keep every source fact and record how the places relate.",evidence,"medium",vec![p.id.clone()],None,rev,birthplace_fingerprint(&births)))?;
        }
    }

    let mut name_buckets: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, person) in people.iter().enumerate() {
        let names: HashSet<String> = std::iter::once(&person.name)
            .chain(person.variants.iter())
            .map(|name| normalize(name))
            .filter(|name| !name.is_empty())
            .collect();
        for name in names {
            name_buckets.entry(name).or_default().push(index);
        }
    }
    let mut candidate_pairs = HashSet::new();
    for group in name_buckets.values() {
        for (position, &i) in group.iter().enumerate() {
            for &j in &group[position + 1..] {
                candidate_pairs.insert((i, j));
            }
        }
    }
    let mut candidate_pairs: Vec<_> = candidate_pairs.into_iter().collect();
    candidate_pairs.sort_unstable();
    for (i, j) in candidate_pairs {
        let a = &people[i];
        let b = &people[j];
        let same_name = matching_names(a, b);
        if same_name && !a.name.is_empty() {
            let a_year = birth(a).map(|(_, y)| y);
            let b_year = birth(b).map(|(_, y)| y);
            let close_births =
                matches!((a_year, b_year), (Some(ay), Some(by)) if (ay - by).abs() <= 2);
            if close_births || a_year.is_none() || b_year.is_none() {
                let a_parents = related_ids(&a.id, &relationships, "parent");
                let b_parents = related_ids(&b.id, &relationships, "parent");
                let a_children = related_ids(&a.id, &relationships, "child");
                let b_children = related_ids(&b.id, &relationships, "child");
                let a_partners = related_ids(&a.id, &relationships, "partner");
                let b_partners = related_ids(&b.id, &relationships, "partner");
                let a_siblings = related_ids(&a.id, &relationships, "sibling");
                let b_siblings = related_ids(&b.id, &relationships, "sibling");
                let parent_conflict = !a_parents.is_empty()
                    && !b_parents.is_empty()
                    && a_parents.is_disjoint(&b_parents);
                let sex_conflict = !a.sex.trim().is_empty()
                    && !b.sex.trim().is_empty()
                    && !a.sex.eq_ignore_ascii_case(&b.sex);
                let death_conflict = matches!((bounds(a.facts.iter().find(|f| f.kind == "death").map(|f| f.date_text.as_str()).unwrap_or("")), bounds(b.facts.iter().find(|f| f.kind == "death").map(|f| f.date_text.as_str()).unwrap_or(""))), (Some(a_death), Some(b_death)) if a_death.latest.zip(b_death.earliest).is_some_and(|(a_end, b_start)| a_end < b_start) || b_death.latest.zip(a_death.earliest).is_some_and(|(b_end, a_start)| b_end < a_start));
                let place_conflict = ["birth", "death"].iter().any(|kind| {
                    let left = fact_places(a, kind);
                    let right = fact_places(b, kind);
                    !left.is_empty() && !right.is_empty() && left.is_disjoint(&right)
                });
                let family_overlap = [
                    (&a_parents, &b_parents),
                    (&a_children, &b_children),
                    (&a_partners, &b_partners),
                    (&a_siblings, &b_siblings),
                ]
                .iter()
                .any(|(left, right)| !left.is_disjoint(right));
                let direct_link = has_direct_link(a, b, &relationships);
                let cited_a = a
                    .facts
                    .iter()
                    .filter(|fact| fact.source_id.is_some())
                    .count();
                let cited_b = b
                    .facts
                    .iter()
                    .filter(|fact| fact.source_id.is_some())
                    .count();
                let mut evidence = vec![format!(
                    "Supporting: matching recorded name — {} / {}",
                    a.name, b.name
                )];
                if close_births {
                    evidence.push(format!(
                        "Supporting: close birth years — {} / {}",
                        a_year.unwrap(),
                        b_year.unwrap()
                    ));
                } else {
                    evidence.push(
                        "Unknown: one or both birth dates are absent or too imprecise to compare."
                            .into(),
                    );
                }
                for (label, left, right) in [
                    ("parents", &a_parents, &b_parents),
                    ("children", &a_children, &b_children),
                    ("spouses or partners", &a_partners, &b_partners),
                    ("siblings", &a_siblings, &b_siblings),
                ] {
                    if !left.is_empty() || !right.is_empty() {
                        let prefix =
                            if !left.is_empty() && !right.is_empty() && !left.is_disjoint(right) {
                                "Supporting"
                            } else if label == "parents" && parent_conflict {
                                "Contradiction"
                            } else {
                                "Unknown"
                            };
                        evidence.push(format!(
                            "{prefix}: {label} — {} / {}",
                            relationship_evidence(left, &by_id),
                            relationship_evidence(right, &by_id)
                        ));
                    }
                }
                if sex_conflict {
                    evidence.push(format!(
                        "Contradiction: recorded sex differs — {} / {}",
                        a.sex, b.sex
                    ));
                }
                if death_conflict {
                    evidence
                        .push("Contradiction: recorded death date ranges do not overlap.".into());
                }
                if place_conflict {
                    evidence.push("Contradiction: recorded birth or death places differ; historical jurisdictions and migrations still need review.".into());
                }
                if direct_link {
                    evidence.push("Contradiction: the records are directly linked in this tree, so they should not be merged as duplicates.".into());
                }
                evidence.push(format!("Provenance: cited facts — {} / {}; imported or user-entered evidence still requires source review.", cited_a, cited_b));
                let (classification, confidence, explanation) = if parent_conflict
                    || sex_conflict
                    || death_conflict
                    || direct_link
                {
                    ("Conflicting evidence / unlikely duplicate", "low", "Family or biographical evidence conflicts with the name match. Different parents can reflect adoption, step-parenting, or an error, but this record pair is not eligible for a merge suggestion.")
                } else if close_births && family_overlap {
                    ("Strong duplicate candidate", "high", "Several deterministic identifiers align, including a family connection. This is an evidence classification, not a calibrated probability; confirm original sources before merging.")
                } else if close_births {
                    ("Possible duplicate requiring review", "medium", "Names and birth years align, but the available family, place, and source evidence is not sufficient to establish identity.")
                } else {
                    ("Insufficient evidence", "low", "The names align, but dates or family evidence are incomplete. Do not infer identity from the name alone.")
                };
                let key = format!("duplicate:{}:{}", a.id, b.id);
                let relationship_fingerprint: Vec<_> = relationships
                    .iter()
                    .filter(|r| {
                        r.from_id == a.id || r.to_id == a.id || r.from_id == b.id || r.to_id == b.id
                    })
                    .map(|r| format!("{}:{}:{}:{}", r.id, r.from_id, r.to_id, r.kind))
                    .collect();
                let mut candidate = issue(
                    key,
                    "duplicate",
                    format!("{}: {}", classification, a.name),
                    explanation,
                    evidence,
                    confidence,
                    vec![a.id.clone(), b.id.clone()],
                    None,
                    rev,
                    format!(
                        "{}:{}:{}",
                        a.version,
                        b.version,
                        relationship_fingerprint.join("|")
                    ),
                );
                if classification == "Strong duplicate candidate"
                    && strong_duplicate(a, b, &relationships)
                {
                    candidate.merge_candidate = Some(MergeCandidate {
                        survivor_id: suggested_survivor(a, b),
                        duplicate_id: if suggested_survivor(a, b) == a.id {
                            b.id.clone()
                        } else {
                            a.id.clone()
                        },
                    });
                }
                push(&mut out, &c, candidate)?;
            }
        }
    }

    let parent_links: Vec<&Relationship> = relationships
        .iter()
        .filter(|r| r.kind.ends_with("_parent"))
        .collect();
    let parent_pairs: HashSet<(&str, &str)> = parent_links
        .iter()
        .map(|r| (r.from_id.as_str(), r.to_id.as_str()))
        .collect();
    for r in &parent_links {
        if let (Some(parent), Some(child)) =
            (by_id.get(r.from_id.as_str()), by_id.get(r.to_id.as_str()))
        {
            if let (Some((_, py)), Some((_, cy))) = (birth(parent), birth(child)) {
                let age = cy - py;
                if !(12..=80).contains(&age) {
                    push(&mut out,&c,issue(format!("parent_age:{}",r.id),"connection",format!("Check {} and {}",parent.name,child.name),"The recorded parent-child dates imply an unusual or impossible age. Approximate dates and non-biological relationships need human review.",vec![format!("{} born {}",parent.name,py),format!("{} born {}",child.name,cy),format!("Recorded relationship: {}",r.kind)],"medium",vec![parent.id.clone(),child.id.clone()],None,rev,format!("{}:{}:{}",parent.version,child.version,r.id)))?;
                }
            }
        }
        if parent_pairs.contains(&(r.to_id.as_str(), r.from_id.as_str())) {
            push(&mut out,&c,issue(format!("cycle:{}",r.id),"connection","Circular parent relationship".into(),"These people appear as parents of each other. Inspect the imported or entered links.",vec![format!("{} → {}",r.from_id,r.to_id)],"high",vec![r.from_id.clone(),r.to_id.clone()],None,rev,r.id.clone()))?;
        }
    }

    if people.len() > 1 {
        let linked: HashSet<&str> = relationships
            .iter()
            .flat_map(|r| [r.from_id.as_str(), r.to_id.as_str()])
            .collect();
        for p in &people {
            if !linked.contains(p.id.as_str()) {
                push(&mut out,&c,issue(format!("unlinked:{}",p.id),"unlinked",format!("{} is not connected",p.name),"This person has no recorded links to anyone in this tree. That may be intentional; review only if you expected a connection.",vec![format!("Person: {}",p.name)],"low",vec![p.id.clone()],None,rev,p.version.to_string()))?;
            }
        }
    }
    out.sort_by_key(|i| {
        (
            i.dismissed,
            match i.severity.as_str() {
                "high" => 0,
                "medium" => 1,
                _ => 2,
            },
            i.title.clone(),
        )
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{FactInput, PersonInput};

    #[test]
    fn uncertain_dates_do_not_create_false_chronology() {
        assert_eq!(bounds("BEF 1900").unwrap().latest, Some(1899));
        assert_eq!(bounds("AFT 1900").unwrap().earliest, Some(1901));
        assert_eq!(bounds("about 1900").unwrap().earliest, Some(1895));
        assert_eq!(year("São Paulo, 1880"), Some(1880));
    }

    #[test]
    fn historical_dual_year_and_gedcom_qualifiers_are_interpreted_conservatively() {
        let dual = bounds("2 Mar 1652/3").unwrap();
        assert_eq!((dual.earliest, dual.latest), (Some(1652), Some(1653)));
        assert!(dual.interpretation.contains("dual year"));
        assert_eq!(
            (
                bounds("BET 1650 AND 1655").unwrap().earliest,
                bounds("BET 1650 AND 1655").unwrap().latest
            ),
            (Some(1650), Some(1655))
        );
        assert_eq!(
            (
                bounds("EST 1700").unwrap().earliest,
                bounds("EST 1700").unwrap().latest
            ),
            (Some(1695), Some(1705))
        );
        assert_eq!(bounds("unknown"), None);
    }

    #[test]
    fn dual_year_death_does_not_create_a_false_birth_after_death_issue() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Historical Person".into(),
                variants: vec![],
                notes: String::new(),
                living_status: "deceased".into(),
                sex: String::new(),
                facts: vec![
                    FactInput {
                        id: None,
                        kind: "birth".into(),
                        date_text: "1653".into(),
                        place: String::new(),
                        detail: String::new(),
                        source_id: None,
                    },
                    FactInput {
                        id: None,
                        kind: "death".into(),
                        date_text: "2 Mar 1652/3".into(),
                        place: "Duxbury, Plymouth, Massachusetts, USA".into(),
                        detail: String::new(),
                        source_id: None,
                    },
                ],
            },
        )
        .unwrap();
        assert!(!list_issues(&store, &tree.id)
            .unwrap()
            .iter()
            .any(|issue| issue.kind == "chronology"));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn conflicting_parent_sets_are_explained_and_never_merge_eligible() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        let person = |name: &str, year: &str| {
            db::save_person(
                &store,
                &tree.id,
                PersonInput {
                    id: None,
                    name: name.into(),
                    variants: vec![],
                    notes: String::new(),
                    living_status: "deceased".into(),
                    sex: String::new(),
                    facts: vec![FactInput {
                        id: None,
                        kind: "birth".into(),
                        date_text: year.into(),
                        place: String::new(),
                        detail: String::new(),
                        source_id: None,
                    }],
                },
            )
            .unwrap()
        };
        let david_a = person("David Putnam", "1652");
        let david_b = person("David Putnam", "1653");
        let parent_a = person("John Putnam", "1620");
        let parent_b = person("Thomas Putnam", "1615");
        db::add_relationship(
            &store,
            &tree.id,
            parent_a.id.clone(),
            david_a.id.clone(),
            "biological_parent".into(),
            None,
        )
        .unwrap();
        db::add_relationship(
            &store,
            &tree.id,
            parent_b.id.clone(),
            david_b.id.clone(),
            "biological_parent".into(),
            None,
        )
        .unwrap();
        let issue = list_issues(&store, &tree.id)
            .unwrap()
            .into_iter()
            .find(|issue| {
                issue.kind == "duplicate"
                    && issue.person_ids.contains(&david_a.id)
                    && issue.person_ids.contains(&david_b.id)
            })
            .unwrap();
        assert!(issue
            .title
            .starts_with("Conflicting evidence / unlikely duplicate"));
        assert!(issue
            .evidence
            .iter()
            .any(|item| item.starts_with("Contradiction: parents")));
        assert!(issue.merge_candidate.is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn approval_undo_preserves_unrelated_edits() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        let input = PersonInput {
            id: None,
            name: "Ada Sample".into(),
            variants: vec![],
            notes: String::new(),
            living_status: "deceased".into(),
            sex: String::new(),
            facts: vec![
                FactInput {
                    id: None,
                    kind: "birth".into(),
                    date_text: "1900".into(),
                    place: String::new(),
                    detail: String::new(),
                    source_id: None,
                },
                FactInput {
                    id: None,
                    kind: "death".into(),
                    date_text: "1890".into(),
                    place: String::new(),
                    detail: String::new(),
                    source_id: None,
                },
            ],
        };
        let person = db::save_person(&store, &tree.id, input).unwrap();
        let issue = list_issues(&store, &tree.id)
            .unwrap()
            .into_iter()
            .find(|i| i.kind == "chronology")
            .unwrap();
        let change_id = db::delete_fact_for_suggestion(
            &store,
            &tree.id,
            issue.proposed_fact_id.as_deref().unwrap(),
            issue.revision,
        )
        .unwrap();
        db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Grace Sample".into(),
                variants: vec![],
                notes: String::new(),
                living_status: "unknown".into(),
                sex: String::new(),
                facts: vec![],
            },
        )
        .unwrap();
        db::undo_change(&store, &tree.id, &change_id).unwrap();
        assert_eq!(
            db::get_person(&store, &tree.id, &person.id)
                .unwrap()
                .facts
                .len(),
            2
        );
        assert_eq!(db::list_people(&store, &tree.id, None).unwrap().len(), 2);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn birthplace_resolution_preserves_facts_and_marks_matching_issue_reviewed() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        let person = db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Place".into(),
                variants: vec![],
                notes: String::new(),
                living_status: "deceased".into(),
                sex: String::new(),
                facts: vec![
                    FactInput {
                        id: None,
                        kind: "birth".into(),
                        date_text: "1900".into(),
                        place: "Poznań, Prussia".into(),
                        detail: String::new(),
                        source_id: None,
                    },
                    FactInput {
                        id: None,
                        kind: "birth".into(),
                        date_text: "1900".into(),
                        place: "Poznań, Poland".into(),
                        detail: String::new(),
                        source_id: None,
                    },
                ],
            },
        )
        .unwrap();
        let issue = list_issues(&store, &tree.id)
            .unwrap()
            .into_iter()
            .find(|item| item.kind == "birthplace")
            .unwrap();
        let preferred = person
            .facts
            .iter()
            .find(|fact| fact.place.contains("Prussia"))
            .unwrap();
        let alternative = person
            .facts
            .iter()
            .find(|fact| fact.id != preferred.id)
            .unwrap();
        db::resolve_birthplace_conflict(
            &store,
            &tree.id,
            &person.id,
            &issue.fingerprint,
            issue.revision,
            db::BirthplaceResolutionInput {
                preferred_fact_id: preferred.id.clone(),
                alternatives: vec![db::BirthplaceAlternativeInput {
                    fact_id: alternative.id.clone(),
                    relation: "same_historical_place".into(),
                }],
            },
        )
        .unwrap();
        let saved = db::get_person(&store, &tree.id, &person.id).unwrap();
        assert_eq!(saved.facts.len(), 2);
        assert_eq!(
            saved.preferred_birth_fact_id.as_deref(),
            Some(preferred.id.as_str())
        );
        assert!(
            list_issues(&store, &tree.id)
                .unwrap()
                .into_iter()
                .find(|item| item.kind == "birthplace")
                .unwrap()
                .reviewed
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn edited_review_fact_can_be_undone() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        let person = db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Sample".into(),
                variants: vec![],
                notes: String::new(),
                living_status: "deceased".into(),
                sex: String::new(),
                facts: vec![FactInput {
                    id: None,
                    kind: "death".into(),
                    date_text: "1890".into(),
                    place: "Rome".into(),
                    detail: String::new(),
                    source_id: None,
                }],
            },
        )
        .unwrap();
        let fact = person.facts.first().unwrap();
        let revision = db::revision(&store.tree(&tree.id).unwrap()).unwrap();
        let change_id = db::update_fact_for_suggestion(
            &store,
            &tree.id,
            &fact.id,
            revision,
            "1891".into(),
            "Roma".into(),
            "Corrected from a source citation".into(),
        )
        .unwrap();
        let edited = db::get_person(&store, &tree.id, &person.id).unwrap();
        assert_eq!(edited.facts[0].date_text, "1891");
        db::undo_change(&store, &tree.id, &change_id).unwrap();
        let restored = db::get_person(&store, &tree.id, &person.id).unwrap();
        assert_eq!(restored.facts[0].date_text, "1890");
        assert_eq!(restored.facts[0].place, "Rome");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn approved_merge_preserves_facts_and_can_be_undone() {
        let base = std::env::temp_dir().join(format!("kinfolk-test-{}", db::id()));
        std::fs::create_dir_all(&base).unwrap();
        let store = Store { base: base.clone() };
        store.catalog().unwrap();
        let tree = db::create_tree(&store, "Test".into()).unwrap();
        let survivor = db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Sample".into(),
                variants: vec!["Ada A. Sample".into()],
                notes: "First note".into(),
                living_status: "deceased".into(),
                sex: "F".into(),
                facts: vec![FactInput {
                    id: None,
                    kind: "birth".into(),
                    date_text: "1900".into(),
                    place: "Rome".into(),
                    detail: String::new(),
                    source_id: None,
                }],
            },
        )
        .unwrap();
        let duplicate = db::save_person(
            &store,
            &tree.id,
            PersonInput {
                id: None,
                name: "Ada Sample".into(),
                variants: vec![],
                notes: "Second note".into(),
                living_status: "deceased".into(),
                sex: "F".into(),
                facts: vec![FactInput {
                    id: None,
                    kind: "death".into(),
                    date_text: "1980".into(),
                    place: "Milan".into(),
                    detail: String::new(),
                    source_id: None,
                }],
            },
        )
        .unwrap();
        let revision = db::revision(&store.tree(&tree.id).unwrap()).unwrap();
        let change_id = db::merge_people_for_suggestion(
            &store,
            &tree.id,
            &survivor.id,
            &duplicate.id,
            revision,
            db::MergePlanInput {
                primary_name: duplicate.name.clone(),
                preferred_birth_fact_id: None,
                decisions: std::collections::HashMap::from([("name".into(), "right".into())]),
            },
        )
        .unwrap();
        let merged = db::get_person(&store, &tree.id, &survivor.id).unwrap();
        assert_eq!(merged.name, duplicate.name);
        assert!(merged
            .variants
            .iter()
            .any(|variant| variant == "Ada A. Sample"));
        assert_eq!(merged.facts.len(), 2);
        assert!(merged.notes.contains("Second note"));
        assert_eq!(db::list_people(&store, &tree.id, None).unwrap().len(), 1);
        db::undo_change(&store, &tree.id, &change_id).unwrap();
        assert_eq!(db::list_people(&store, &tree.id, None).unwrap().len(), 2);
        assert_eq!(
            db::get_person(&store, &tree.id, &duplicate.id)
                .unwrap()
                .facts
                .len(),
            1
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}

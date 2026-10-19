//! Validate the official content blocks without treating the chapter heading as a paragraph.
use html5ever::{tendril::StrTendril, tokenizer::{BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer}};
use std::cell::RefCell;

#[derive(Default, Debug)]
struct Frame {
    name: String,
    blocks: usize,
    continuation_separator: bool,
    has_text: bool,
}
#[derive(Default, Debug)]
struct Structure {
    stack: Vec<Frame>,
    blocks: i64,
    paragraphs: i64,
    headings: i64,
    wrapped_paragraphs: i64,
    unwrapped_text_paragraphs: i64,
    invalid: bool,
}
#[derive(Default)]
struct Sink(RefCell<Structure>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        if let Token::CharacterTokens(text) = &token {
            if !text.trim().is_empty() {
                for frame in &mut self.0.borrow_mut().stack { frame.has_text = true; }
            }
        }
        if let Token::TagToken(tag) = token {
            let name = tag.name.as_ref();
            let mut state = self.0.borrow_mut();
            if matches!(name, "script" | "style" | "iframe" | "object" | "svg") {
                state.invalid = true;
            }
            // Published books split a paragraph into runs at line breaks and
            // inline footnote images. Neither creates another body paragraph.
            if matches!(name, "br" | "img") && tag.kind == TagKind::StartTag {
                if let Some(frame) = state.stack.last_mut() {
                    if matches!(frame.name.as_str(), "p" | "h1" | "aside") && frame.blocks > 0 {
                        frame.continuation_separator = true;
                    }
                }
            }
            if matches!(name, "blk" | "p" | "h1" | "aside") {
                if tag.kind == TagKind::StartTag {
                    if tag.self_closing { state.invalid = true; }
                    if name == "blk" {
                        let parent = state.stack.last_mut();
                        match parent {
                            Some(frame) if matches!(frame.name.as_str(), "p" | "h1" | "aside") && (frame.blocks == 0 || frame.continuation_separator) => {
                                frame.blocks += 1;
                                frame.continuation_separator = false;
                            }
                            _ => state.invalid = true,
                        }
                        if state.stack.last().is_some_and(|frame| frame.name == "p" && frame.blocks == 1) { state.wrapped_paragraphs += 1; }
                        state.blocks += 1;
                    } else {
                        if !state.stack.is_empty() { state.invalid = true; }
                        if name == "p" { state.paragraphs += 1; }
                        else if name == "h1" { state.headings += 1; }
                    }
                    state.stack.push(Frame { name: name.to_owned(), blocks: 0, continuation_separator: false, has_text: false });
                } else {
                    match state.stack.pop() {
                        Some(frame) if frame.name == name => {
                            if name == "p" && frame.blocks == 0 && frame.has_text { state.unwrapped_text_paragraphs += 1; }
                        }
                        _ => state.invalid = true,
                    }
                }
            }
        }
        TokenSinkResult::Continue
    }
}

pub(crate) fn validate(text: &str, expected: i64, free_paragraphs: Option<i64>) -> Result<(), String> {
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(text));
    let tokenizer = Tokenizer::new(Sink::default(), Default::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    let state = tokenizer.sink.0.borrow();
    // paragraphs_num has both conventions, even within the same book and
    // text_type. free_para_nums consistently counts body <p> nodes in observed
    // responses, including empty layout paragraphs. Require that independent
    // count before accepting a total which includes the heading; otherwise a
    // missing body paragraph could be mistaken for this format difference.
    let count_matches = expected == state.paragraphs
        || (state.headings == 1 && expected == state.paragraphs + 1
            && free_paragraphs == Some(state.paragraphs));
    if expected <= 0 || !count_matches || state.paragraphs == 0 || state.invalid
        || !state.stack.is_empty()
        || free_paragraphs.is_some_and(|count|count != state.paragraphs)
        || (state.blocks > 0 && (state.unwrapped_text_paragraphs > 0 || state.headings > 1)) {
        return Err("官方正文段落不完整，未标记已读".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn diagnose(text: &str, expected: i64) -> serde_json::Value {
    #[derive(Default)]
    struct Redacted(RefCell<(String, Vec<String>)>);
    impl TokenSink for Redacted {
        type Handle = ();
        fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
            let mut output = self.0.borrow_mut();
            match token {
                Token::TagToken(tag) => {
                    let close = if tag.kind == TagKind::EndTag { "/" } else { "" };
                    let mut rendered = format!("<{close}{}",tag.name);
                    for attr in tag.attrs {
                        if matches!(attr.name.local.as_ref(), "idx" | "p_idx") && attr.value.bytes().all(|b|b.is_ascii_digit()) {
                            rendered.push_str(&format!(" {}=\"{}\"",attr.name.local,attr.value));
                        }
                    }
                    if tag.self_closing { rendered.push('/'); }
                    rendered.push('>');
                    output.0.push_str(&rendered);
                    output.1.push(rendered);
                }
                Token::CharacterTokens(value) if !value.trim().is_empty() => output.0.push('X'),
                _ => {},
            }
            TokenSinkResult::Continue
        }
    }
    let queue = BufferQueue::default(); queue.push_back(StrTendril::from_slice(text));
    let tokenizer = Tokenizer::new(Sink::default(), Default::default());
    let _ = tokenizer.feed(&queue); tokenizer.end();
    let state = tokenizer.sink.0.borrow();
    let queue = BufferQueue::default(); queue.push_back(StrTendril::from_slice(text));
    let redacted = Tokenizer::new(Redacted::default(), Default::default());
    let _ = redacted.feed(&queue); redacted.end();
    let output = redacted.sink.0.borrow();
    serde_json::json!({"expected":expected,"paragraphs":state.paragraphs,"blocks":state.blocks,"headings":state.headings,
        "wrappedParagraphs":state.wrapped_paragraphs,"invalid":state.invalid,"stackDepth":state.stack.len(),
        "firstTags":output.1.iter().take(24).collect::<Vec<_>>(),"structuralHtml":output.0})
}

#[cfg(test)]
mod tests {
    use super::validate;
    #[test]
    fn both_official_title_count_conventions_require_matching_body_counts() {
        let html = r#"<html><body><h1><blk>标题</blk></h1><p idx="0"><blk>甲</blk></p><p idx="1"><blk>乙</blk></p></body></html>"#;
        assert!(validate(html, 2, Some(2)).is_ok());
        assert!(validate(html, 3, Some(2)).is_ok());
        assert!(validate(html, 3, None).is_err());
        assert!(validate(html, 3, Some(3)).is_err());
    }
    #[test]
    fn legacy_format_and_empty_layout_paragraph_keep_their_counts() {
        assert!(validate(r#"<h1>标题</h1><p idx="0">甲<br>乙</p><p idx="1"><em>丙</em></p>"#, 2, None).is_ok());
        assert!(validate(r#"<H1><BLK>标题</BLK></H1><P idx="0"><BLK>正文</BLK></P><P></P>"#, 2, Some(2)).is_ok());
    }
    #[test]
    fn line_break_continuations_keep_the_same_paragraph_count() {
        let html = "<h1><span><blk>上行标题</blk></span><br/><blk>下行标题</blk></h1><p><blk>正文上行</blk><br/><blk>正文下行</blk><br><blk>第三行</blk></p>";
        assert!(validate(html, 1, Some(1)).is_ok());
        assert!(validate(html, 2, Some(1)).is_ok());
        assert!(validate(html, 2, Some(2)).is_err());
        assert!(validate(&html.replacen("</blk>", "", 1), 1, Some(1)).is_err());
        assert!(validate("<p><blk>正文</blk><br/><blk>未结束", 1, Some(1)).is_err());
        assert!(validate("<p><blk>注释前</blk><a><img/></a><blk>注释后</blk></p>", 1, Some(1)).is_ok());
        assert!(validate("<p><blk>注释前</blk><a><img/></a><blk>注释后</blk></p>", 2, Some(2)).is_err());
    }
    #[test]
    fn footnotes_do_not_count_as_missing_body_paragraphs() {
        let html = "<h1><blk>标题</blk></h1><p><blk>正文</blk></p><section><aside><blk>注释</blk></aside></section>";
        assert!(validate(html, 1, Some(1)).is_ok());
        assert!(validate(html, 2, Some(2)).is_err());
        assert!(validate(&html.replace("<p><blk>正文</blk></p>", ""), 1, Some(1)).is_err());
        assert!(validate(&html.replace("</aside>", ""), 1, Some(1)).is_err());
    }
    #[test]
    fn comments_attributes_and_similarly_named_tags_are_not_paragraphs() {
        assert!(validate(r#"<!-- <p>not text</p> --><picture></picture><p title="<p>">正文</p>"#, 1, None).is_ok());
        assert!(validate("<picture></picture>", 1, None).is_err());
    }
    #[test]
    fn missing_or_malformed_blocks_are_not_marked_complete() {
        for (html, count) in [
            ("<h1><blk>标题</blk></h1><p><blk>正文", 1),
            ("<h1><blk>标题</blk></h1><p><blk>正文</blk></p>", 3),
            ("<blk></blk><p><blk>正文</blk></p>", 2),
            ("<p><blk>甲</blk><blk>乙</blk></p>", 1),
            ("<p><blk>甲</p></blk>", 1),
            ("<p><blk>甲</blk></p><p>乙</p>", 2),
            ("<p>正文</p>", 0), ("<h1>只有标题</h1>", 1),
            ("<script>var x='<p>假段落</p>';</script><p>正文</p>", 1),
        ] { assert!(validate(html, count, Some(count)).is_err(), "{html}"); }
    }
    #[test]
    fn redacted_real_structures_pass_and_lost_paragraphs_fail() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chapter-structures");
        let mut checked = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e|e.to_str()) != Some("json") {continue;}
            let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let html = fixture["html"].as_str().unwrap();
            let expected = fixture["expected"].as_i64().unwrap();
            let free = fixture["freeParagraphs"].as_i64();
            assert!(validate(html, expected, free).is_ok(), "{}",path.display());
            let start = html.find("<p ").or_else(||html.find("<p>")).unwrap();
            let end = start + html[start..].find("</p>").unwrap() + 4;
            let missing = format!("{}{}",&html[..start],&html[end..]);
            assert!(validate(&missing,expected,free).is_err(), "missing paragraph: {}",path.display());
            assert!(validate(&html.replacen("</blk>","",1),expected,free).is_err(), "unclosed block: {}",path.display());
            checked += 1;
        }
        assert_eq!(checked, 15);
    }
}

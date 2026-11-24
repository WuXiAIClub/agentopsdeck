import { useState } from "react";
import { createRoot } from "react-dom/client";
import NotebookEditor from "../../src/components/NotebookEditor";
import { NotebookMarkdown } from "../../src/components/NotebookMarkdown";
import { setRecoveryScope } from "../../src/api";
import "../../src/styles.css";
const text = ["# Narrow notebook", "https://example.invalid/" + "long-path-".repeat(90), "```text", "long_code_".repeat(100), "```", "| Column A | Column B | Column C |", "| --- | --- | --- |", "| " + "cell".repeat(70) + " | text | final |", "- [ ] " + "task".repeat(100)].join("\n\n").replaceAll("\n\n|", "\n|");
function App() {
  const [value, setValue] = useState(text);
  return <main style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{[240, 320, 390].flatMap(width => ["edit", "preview", "source"].map(mode => <section key={width + mode} className="session-notebook session-notebook--embedded" data-case={width + mode} style={{ width, height: 420 }}>
    <div className="notebook-body">{mode === "edit" ? <NotebookEditor foldKey={`fixture-${width}`} text={value} disabled={false} label="Note content" onChange={setValue} onSave={() => {}} onReady={() => {}} /> : mode === "preview" ? <NotebookMarkdown text={value} disabled={false} onChange={setValue} /> : <textarea aria-label="Markdown source" value={value} onChange={event => setValue(event.target.value)} />}</div>
  </section>))}</main>;
}
setRecoveryScope((new URLSearchParams(location.search).has('other-account') ? 'b' : 'a').repeat(64));
createRoot(document.getElementById("root")!).render(<App />);

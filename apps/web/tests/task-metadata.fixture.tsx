import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { validBoardContent, type BoardTask } from '@agentopsdeck/shared';
import { TaskMetadataEditor, TaskMetadataSummary } from '../src/components/TaskMetadata';
import '../src/styles.css';

function App() {
  const [task, setTask] = useState<BoardTask>({ id: '12345678-1234-1234-1234-123456789abc', title: 'Task', detail: '', status: 'todo' });
  const [locked, setLocked] = useState(false);
  return <div className="workspace-taskboard"><div className="workspace-task-popover" role="dialog" aria-label="Task attributes"
    style={{ display: 'block', top: 8, left: 8 }}>
    <TaskMetadataSummary task={task} />
    <TaskMetadataEditor task={task} disabled={false} readOnly={locked} onChange={setTask} />
    <button disabled={!validBoardContent({ title: 'Plan', tasks: [task] })}>Save</button>
    <button onClick={() => setLocked(value => !value)}>Toggle lock</button>
    <output>{JSON.stringify(task)}</output>
  </div></div>;
}
createRoot(document.getElementById('root')!).render(<App />);

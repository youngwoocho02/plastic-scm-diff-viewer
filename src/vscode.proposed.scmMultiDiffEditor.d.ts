import 'vscode';

declare module 'vscode' {
  interface SourceControlResourceState {
    readonly multiDiffEditorOriginalUri?: Uri;
    readonly multiFileDiffEditorModifiedUri?: Uri;
  }

  interface SourceControl {
    createResourceGroup(
      id: string,
      label: string,
      options: { multiDiffEditorEnableViewChanges?: boolean }
    ): SourceControlResourceGroup;
  }
}

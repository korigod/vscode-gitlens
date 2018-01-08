'use strict';
import { Functions, IDeferrable, Strings } from './../system';
import { ConfigurationChangeEvent, Disposable, Event, EventEmitter, TextDocument, TextDocumentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';
import { configuration } from './../configuration';
import { CommandContext, DocumentSchemes, isActiveDocument, isTextEditor, setCommandContext } from './../constants';
import { DocumentBlameStateChangeEvent, TrackedDocument } from './trackedDocument';

export { CachedBlame, CachedDiff, CachedLog, GitDocumentState } from './gitDocumentState';
export * from './trackedDocument';

export interface DocumentDirtyStateChangeEvent<T> {

    readonly editor: TextEditor;
    readonly document: TrackedDocument<T>;
    readonly dirty: boolean;
}

export interface DocumentDirtyIdleTriggerEvent<T> {
    readonly editor: TextEditor;
    readonly document: TrackedDocument<T>;
}

export class DocumentTracker<T> extends Disposable {

    private _onDidChangeBlameState = new EventEmitter<DocumentBlameStateChangeEvent<T>>();
    get onDidChangeBlameState(): Event<DocumentBlameStateChangeEvent<T>> {
        return this._onDidChangeBlameState.event;
    }

    private _onDidChangeDirtyState = new EventEmitter<DocumentDirtyStateChangeEvent<T>>();
    get onDidChangeDirtyState(): Event<DocumentDirtyStateChangeEvent<T>> {
        return this._onDidChangeDirtyState.event;
    }

    private _onDidTriggerDirtyIdle = new EventEmitter<DocumentDirtyIdleTriggerEvent<T>>();
    get onDidTriggerDirtyIdle(): Event<DocumentDirtyIdleTriggerEvent<T>> {
        return this._onDidTriggerDirtyIdle.event;
    }

    private _dirtyIdleTriggerDelay: number;
    private readonly _disposable: Disposable | undefined;
    private readonly _documentMap: Map<TextDocument | string, TrackedDocument<T>> = new Map();

    constructor() {
        super(() => this.dispose());

        this._disposable = Disposable.from(
            configuration.onDidChange(this.onConfigurationChanged, this),
            window.onDidChangeActiveTextEditor(Functions.debounce(this.onActiveTextEditorChanged, 0), this),
            workspace.onDidChangeTextDocument(Functions.debounce(this.onTextDocumentChanged, 50), this),
            workspace.onDidCloseTextDocument(this.onTextDocumentClosed, this),
            workspace.onDidSaveTextDocument(this.onTextDocumentSaved, this)
        );

        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this._disposable && this._disposable.dispose();

        this.clear();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        // Only rest the cached state if we aren't initializing
        if (!initializing && (configuration.changed(e, configuration.name('blame')('ignoreWhitespace').value, null) ||
            configuration.changed(e, configuration.name('advanced')('caching')('enabled').value))) {
            for (const d of this._documentMap.values()) {
                d.reset('config');
            }
        }

        const section = configuration.name('advanced')('blame')('delayAfterEdit').value;
        if (initializing || configuration.changed(e, section)) {
            this._dirtyIdleTriggerDelay = configuration.get<number>(section);
            this._dirtyIdleTriggeredDebounced = undefined;
        }
    }

    private onActiveTextEditorChanged(editor: TextEditor | undefined) {
        if (editor !== undefined && !isTextEditor(editor)) return;

        if (editor === undefined) {
            setCommandContext(CommandContext.ActiveIsRevision, false);
            setCommandContext(CommandContext.ActiveFileIsTracked, false);
            setCommandContext(CommandContext.ActiveIsBlameable, false);
            setCommandContext(CommandContext.ActiveHasRemote, false);

            return;
        }

        const doc = this._documentMap.get(editor.document);
        if (doc !== undefined) {
            doc.activate();

            return;
        }

        // No need to activate this, as it is implicit in initialization if currently active
        this.addCore(editor.document);
    }

    private onTextDocumentChanged(e: TextDocumentChangeEvent) {
        if (e.document.uri.scheme !== DocumentSchemes.File) return;

        let doc = this._documentMap.get(e.document);
        if (doc === undefined) {
            doc = this.addCore(e.document);
        }

        doc.reset('document');

        const dirty = e.document.isDirty;
        const editor = window.activeTextEditor;

        // If we have an idle tracker, either reset or cancel it
        if (this._dirtyIdleTriggeredDebounced !== undefined) {
            if (dirty) {
                this._dirtyIdleTriggeredDebounced({ editor: editor!, document: doc });
            }
            else {
                this._dirtyIdleTriggeredDebounced.cancel();
            }
        }

        if (!doc.forceDirtyStateChangeOnNextDocumentChange && doc.dirty === dirty) return;

        doc.resetForceDirtyStateChangeOnNextDocumentChange();
        doc.dirty = dirty;

        // Only fire state change events for the active document
        if (editor === undefined || editor.document !== e.document) return;

        this.fireDocumentDirtyStateChanged({ editor: editor, document: doc, dirty: doc.dirty });
    }

    private onTextDocumentClosed(document: TextDocument) {
        const doc = this._documentMap.get(document);
        if (doc === undefined) return;

        doc.dispose();
        this._documentMap.delete(document);
        this._documentMap.delete(doc.key);
    }

    private onTextDocumentSaved(document: TextDocument) {
        let doc = this._documentMap.get(document);
        if (doc !== undefined) {
            doc.update({ forceBlameChange: true});

            return;
        }

        // If we are saving the active document make sure we are tracking it
        if (isActiveDocument(document)) {
            doc = this.addCore(document);
        }
    }

    async add(fileName: string): Promise<TrackedDocument<T>>;
    async add(document: TextDocument): Promise<TrackedDocument<T>>;
    async add(uri: Uri): Promise<TrackedDocument<T>>;
    async add(documentOrId: string | TextDocument | Uri): Promise<TrackedDocument<T>> {
        return this._add(documentOrId);
    }

    clear() {
        for (const d of this._documentMap.values()) {
            d.dispose();
        }

        this._documentMap.clear();
    }

    async get(fileName: string): Promise<TrackedDocument<T> | undefined>;
    async get(document: TextDocument): Promise<TrackedDocument<T> | undefined>;
    async get(uri: Uri): Promise<TrackedDocument<T> | undefined>;
    async get(documentOrId: string | TextDocument | Uri): Promise<TrackedDocument<T> | undefined> {
        return await this._get(documentOrId);
    }

    async getOrAdd(fileName: string): Promise<TrackedDocument<T>>;
    async getOrAdd(document: TextDocument): Promise<TrackedDocument<T>>;
    async getOrAdd(uri: Uri): Promise<TrackedDocument<T>>;
    async getOrAdd(documentOrId: string | TextDocument | Uri): Promise<TrackedDocument<T>> {
        return await this._get(documentOrId) || await this._add(documentOrId);
    }

    has(fileName: string): boolean;
    has(document: TextDocument): boolean;
    has(uri: Uri): boolean;
    has(key: string | TextDocument | Uri): boolean {
        if (typeof key === 'string' || key instanceof Uri) {
            key = DocumentTracker.toStateKey(key);
        }
        return this._documentMap.has(key);
    }

    private async _add(documentOrId: string | TextDocument | Uri): Promise<TrackedDocument<T>> {
        if (typeof documentOrId === 'string') {
            documentOrId = await workspace.openTextDocument(documentOrId);
        }
        else if (documentOrId instanceof Uri) {
            documentOrId = await workspace.openTextDocument(documentOrId);
        }

        const doc = await this.addCore(documentOrId);
        await doc.ensureInitialized();

        return doc;
    }

    private async _get(documentOrId: string | TextDocument | Uri) {
        if (typeof documentOrId === 'string' || documentOrId instanceof Uri) {
            documentOrId = DocumentTracker.toStateKey(documentOrId);
        }

        const doc = this._documentMap.get(documentOrId);
        if (doc === undefined) return undefined;

        await doc.ensureInitialized();
        return doc;
    }

    private addCore(document: TextDocument): TrackedDocument<T> {
        const key = DocumentTracker.toStateKey(document.uri);

        // Always start out false, so we will fire the event if needed
        const doc = new TrackedDocument<T>(document, key, false, {
            onDidBlameStateChange: (e: DocumentBlameStateChangeEvent<T>) => this._onDidChangeBlameState.fire(e)
        });
        this._documentMap.set(document, doc);
        this._documentMap.set(key, doc);

        return doc;
    }

    private _dirtyIdleTriggeredDebounced: (((e: DocumentDirtyIdleTriggerEvent<T>) => void) & IDeferrable) | undefined;
    private _dirtyStateChangedDebounced: (((e: DocumentDirtyStateChangeEvent<T>) => void) & IDeferrable) | undefined;
    private fireDocumentDirtyStateChanged(e: DocumentDirtyStateChangeEvent<T>) {
        if (e.dirty) {
            setImmediate(async () => {
                if (this._dirtyStateChangedDebounced !== undefined) {
                    this._dirtyStateChangedDebounced.cancel();
                }

                if (window.activeTextEditor !== e.editor) return;

                await e.document.ensureInitialized();
                this._onDidChangeDirtyState.fire(e);
            });

            if (this._dirtyIdleTriggerDelay > 0) {
                if (this._dirtyIdleTriggeredDebounced === undefined) {
                    this._dirtyIdleTriggeredDebounced = Functions.debounce(async (e: DocumentDirtyIdleTriggerEvent<T>) => {
                        if (this._dirtyIdleTriggeredDebounced !== undefined && this._dirtyIdleTriggeredDebounced.pending!()) return;

                        await e.document.ensureInitialized();

                        e.document.isDirtyIdle = true;
                        this._onDidTriggerDirtyIdle.fire(e);
                    }, this._dirtyIdleTriggerDelay, { track: true });
                }

                this._dirtyIdleTriggeredDebounced({ editor: e.editor, document: e.document });
            }

            return;
        }

        if (this._dirtyStateChangedDebounced === undefined) {
            this._dirtyStateChangedDebounced = Functions.debounce(async (e: DocumentDirtyStateChangeEvent<T>) => {
                if (window.activeTextEditor !== e.editor) return;

                await e.document.ensureInitialized();
                this._onDidChangeDirtyState.fire(e);
            }, 250);
        }

        this._dirtyStateChangedDebounced(e);
    }

    static toStateKey(fileName: string): string;
    static toStateKey(uri: Uri): string;
    static toStateKey(fileNameOrUri: string | Uri): string;
    static toStateKey(fileNameOrUri: string | Uri): string {
        return Strings.normalizePath(typeof fileNameOrUri === 'string' ? fileNameOrUri : fileNameOrUri.fsPath).toLowerCase();
    }
}

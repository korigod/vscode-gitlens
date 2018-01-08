'use strict';
import { TextEditor, TextEditorEdit, Uri, window } from 'vscode';
import { LineAnnotationType } from '../currentLineController';
import { Commands, EditorCommand } from './common';
import { Container } from '../container';
import { configuration } from '../configuration';
import { Logger } from '../logger';

export interface ShowLineBlameCommandArgs {
    type?: LineAnnotationType;
}

export class ShowLineBlameCommand extends EditorCommand {

    constructor() {
        super(Commands.ShowLineBlame);
    }

    async execute(editor: TextEditor, edit: TextEditorEdit, uri?: Uri, args: ShowLineBlameCommandArgs = {}): Promise<any> {
        if (editor === undefined) return undefined;

        try {
            if (args.type === undefined) {
                args = { ...args, type: configuration.get<LineAnnotationType>(configuration.name('blame')('line')('annotationType').value) };
            }

            return Container.lineAnnotations.showAnnotations(editor, args.type!);
        }
        catch (ex) {
            Logger.error(ex, 'ShowLineBlameCommand');
            return window.showErrorMessage(`Unable to show line blame annotations. See output channel for more details`);
        }
    }
}
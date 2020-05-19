import * as path from 'path';
import * as net from 'net';
import {
  ChildProcessWithoutNullStreams,
  spawn,
} from 'child_process';
import {
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  Scope,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  ThreadEvent,
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { StopWatch } from 'stopwatch-node';
import * as safeEval from 'safe-eval';
import AhkIncludeResolver from '@zero-plusplus/ahk-include-path-resolver';
import { ConditionalEvaluator } from './util/ConditionalEvaluator';
import * as dbgp from './dbgpSession';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  runtime: string;
  stopOnEntry?: boolean;
  hostname?: string;
  port?: number;
  maxChildren: number;
  version: 1 | 2;
  useAdvancedBreakpoint: boolean;
}
export class AhkDebugSession extends LoggingDebugSession {
  private server!: net.Server;
  private session!: dbgp.Session;
  private ahkProcess!: ChildProcessWithoutNullStreams;
  private config!: LaunchRequestArguments;
  private readonly contexts = new Map<number, dbgp.Context>();
  private stackFrameIdCounter = 1;
  private readonly stackFrames = new Map<number, dbgp.StackFrame>();
  private variableReferenceCounter = 1;
  private readonly objectProperties = new Map<number, dbgp.ObjectProperty>();
  private readonly breakpoints: { [key: string]: dbgp.Breakpoint | undefined} = {};
  private conditionalEvaluator!: ConditionalEvaluator;
  private readonly stopwatch = new StopWatch('ahk-process');
  constructor() {
    super('ahk-debug.txt');

    this.setDebuggerColumnsStartAt1(true);
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerPathFormat('uri');
  }
  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    response.body = {
      supportsConditionalBreakpoints: true,
      supportsConfigurationDoneRequest: true,
      supportsHitConditionalBreakpoints: true,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: true,
    };

    this.sendResponse(response);
  }
  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
    this.ahkProcess.kill();
    this.session.close();
    this.server.close();

    this.stopwatch.stop();
    this.sendEvent(new OutputEvent(this.stopwatch.shortSummary(), 'execution-time'));
    this.shutdown();
  }
  protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
    this.config = args;
    const lunchScript = (): void => {
      const ahkProcess = spawn(
        args.runtime,
        [ `/Debug=${String(args.hostname)}:${String(args.port)}`, `${args.program}` ],
        { cwd: path.dirname(args.program) },
      );
      ahkProcess.stdout.on('data', (chunkData: string | Buffer) => {
        this.sendEvent(new OutputEvent(String(chunkData), 'stdout'));
      });
      ahkProcess.stderr.on('data', (chunkData: Buffer) => {
        this.sendEvent(new OutputEvent(String(chunkData), 'stderr'));
      });

      this.ahkProcess = ahkProcess;
    };
    const createServer = (): void => {
      const disposeConnection = (error?: Error): void => {
        if (error) {
          this.sendEvent(new OutputEvent(`Session closed for the following reasons: ${error.message}\n`));
        }
        this.sendEvent(new ThreadEvent('Session exited.', this.session.id));

        if (typeof this.session === 'undefined') {
          return;
        }
        this.session.close();
      };

      this.server = net.createServer()
        .listen(args.port, args.hostname)
        .on('connection', (socket) => {
          try {
            this.session = new dbgp.Session(socket)
              .on('init', (initPacket: dbgp.InitPacket) => {
                if (typeof this.session === 'undefined') {
                  return;
                }
                // Request breakpoints from VS Code
                this.sendEvent(new InitializedEvent());
              })
              .on('warning', (warning: string) => {
                this.sendEvent(new OutputEvent(`${warning}\n`));
              })
              .on('error', disposeConnection)
              .on('close', disposeConnection);

            this.conditionalEvaluator = new ConditionalEvaluator(this.session);
            this.sendEvent(new ThreadEvent('Session started.', this.session.id));
          }
          catch (error) {
            this.sendEvent(new ThreadEvent('Failed to start session.', this.session.id));
            this.sendEvent(new TerminatedEvent('Debug exited'));
          }
        });
    };

    try {
      createServer();
      lunchScript();
    }
    catch (error) {
      this.sendErrorResponse(response, error);
      return;
    }

    this.stopwatch.start();
    this.sendResponse(response);
  }
  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    const filePath = args.source.path ?? '';
    const fileUri = this.convertClientPathToDebugger(filePath);
    const dbgpBreakpoint = (await this.session.sendBreakpointListCommand()).breakpoints;

    // Clear dbgp breakpoints from current file
    await Promise.all(dbgpBreakpoint
      .filter((dbgpBreakpoint) => {
        // (breakpoint.fileUri === fileUri) is not Equals.
        // breakpoint.fileUri: file:///W%3A/project/vscode-ahk-debug/demo/demo.ahk"
        // fileUri:            file:///w:/project/vscode-ahk-debug/demo/demo.ahk
        const _fileUri = this.convertDebuggerPathToClient(dbgpBreakpoint.fileUri);
        if (filePath.toLowerCase() === _fileUri.toLowerCase()) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete this.breakpoints[`${filePath.toLowerCase()}${dbgpBreakpoint.line}`];
          return true;
        }
        return false;
      })
      .map(async(dbgpBreakpoint) => {
        return this.session.sendBreakpointRemoveCommand(dbgpBreakpoint);
      }));


    const vscodeBreakpoints: DebugProtocol.Breakpoint[] = [];
    if (args.breakpoints) {
      const promise = Promise.all(args.breakpoints
        .map(async(vscodeBreakpoint, index) => {
          try {
            const { id } = await this.session.sendBreakpointSetCommand(fileUri, vscodeBreakpoint.line);
            const { line } = await this.session.sendBreakpointGetCommand(id);

            const dbgpBreakpoint = this.breakpoints[`${filePath}${line}`];
            if (dbgpBreakpoint?.advancedData) {
              dbgpBreakpoint.advancedData.condition = vscodeBreakpoint.condition;
              dbgpBreakpoint.advancedData.hitCondition = vscodeBreakpoint.hitCondition;
              dbgpBreakpoint.advancedData.logMessage = vscodeBreakpoint.logMessage;
            }
            else {
              this.breakpoints[`${filePath.toLowerCase()}${line}`] = new dbgp.Breakpoint(fileUri, line, {
                counter: 0,
                condition: vscodeBreakpoint.condition,
                hitCondition: vscodeBreakpoint.hitCondition,
                logMessage: vscodeBreakpoint.logMessage,
              });
            }

            vscodeBreakpoints[index] = {
              id,
              line,
              verified: true,
            };
          }
          catch (error) {
            vscodeBreakpoints[index] = {
              verified: false,
              message: error.message,
            };
          }
        }));

      if (this.session.isRunningContinuationCommand) {
        promise.catch((error) => {
          this.sendEvent(new OutputEvent(error.message));
        });
      }
      else {
        await promise;
      }
    }

    response.body = { breakpoints: vscodeBreakpoints };
    this.sendResponse(response);
  }
  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): Promise<void> {
    await this.session.sendFeatureSetCommand('max_children', this.config.maxChildren);

    const dbgpResponse = this.config.stopOnEntry
      ? await this.session.sendStepIntoCommand()
      : await this.session.sendRunCommand();

    if (this.config.useAdvancedBreakpoint) {
      this.checkContinuationStatus(dbgpResponse, !this.config.stopOnEntry);
      return;
    }

    this.checkContinuationStatus(dbgpResponse);
  }
  protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): Promise<void> {
    const dbgpResponse = await this.session.sendRunCommand();

    this.sendResponse(response);
    this.checkContinuationStatus(dbgpResponse, true);
  }
  protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): Promise<void> {
    const dbgpResponse = await this.session.sendStepOverCommand();
    this.sendResponse(response);
    this.checkContinuationStatus(dbgpResponse);
  }
  protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): Promise<void> {
    const dbgpResponse = await this.session.sendStepIntoCommand();
    this.sendResponse(response);
    this.checkContinuationStatus(dbgpResponse);
  }
  protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): Promise<void> {
    const dbgpResponse = await this.session.sendStepOutCommand();
    this.sendResponse(response);
    this.checkContinuationStatus(dbgpResponse);
  }
  protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
    response.body = { threads: [ new Thread(this.session.id, 'Thread 1') ] };
    this.sendResponse(response);
  }
  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): Promise<void> {
    const { stackFrames } = await this.session.sendStackGetCommand();

    response.body = {
      stackFrames: stackFrames.map((stackFrame) => {
        const id = this.stackFrameIdCounter++;
        const filePath = this.convertDebuggerPathToClient(stackFrame.fileUri);
        const source = {
          name: path.basename(filePath),
          path: stackFrame.fileUri,
        } as DebugProtocol.Source;

        this.stackFrames.set(id, stackFrame);
        return {
          id,
          source,
          name: stackFrame.name,
          line: stackFrame.line,
          column: 1,
        } as StackFrame;
      }),
    };

    this.sendResponse(response);
  }
  protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): Promise<void> {
    const stackFrame = this.stackFrames.get(args.frameId);
    if (typeof stackFrame === 'undefined') {
      throw new Error(`Unknown frameId ${args.frameId}`);
    }
    const { contexts } = await this.session.sendContextNamesCommand(stackFrame);

    response.body = {
      scopes: contexts.map((context) => {
        const variableReference = this.variableReferenceCounter++;

        this.contexts.set(variableReference, context);
        return new Scope(context.name, variableReference);
      }),
    };

    this.sendResponse(response);
  }
  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
    let properties: dbgp.Property[] = [];

    if (this.contexts.has(args.variablesReference)) {
      const context = this.contexts.get(args.variablesReference)!;
      properties = (await this.session.sendContextGetCommand(context)).properties;
    }
    else if (this.objectProperties.has(args.variablesReference)) {
      const objectProperty = this.objectProperties.get(args.variablesReference)!;
      const { children } = (await this.session.sendPropertyGetCommand(objectProperty)).properties[0] as dbgp.ObjectProperty;
      properties = children;
    }

    const variables: DebugProtocol.Variable[] = [];
    for (const property of properties) {
      let variablesReference = 0, indexedVariables, namedVariables;

      if (args.filter) {
        if (args.filter === 'named' && property.isIndex) {
          continue;
        }
        if (args.filter === 'indexed') {
          if (!property.isIndex) {
            continue;
          }
          const index = property.index!;
          const start = args.start! + 1;
          const end = args.start! + args.count!;
          const contains = start <= index && index <= end;
          if (!contains) {
            continue;
          }
        }
      }

      if (property.type === 'object') {
        const objectProperty = property as dbgp.ObjectProperty;

        variablesReference = this.variableReferenceCounter++;
        this.objectProperties.set(variablesReference, objectProperty);
        if (objectProperty.isArray) {
          const maxIndex = objectProperty.maxIndex!;
          if (100 < maxIndex) {
            indexedVariables = maxIndex;
            namedVariables = 1;
          }
        }
      }

      const name = property.isIndex ? String(property.index!) : property.name;
      variables.push({
        name,
        type: property.type,
        value: property.displayValue,
        variablesReference,
        indexedVariables,
        namedVariables,
      });
    }

    response.body = { variables };
    this.sendResponse(response);
  }
  protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
    this.sendResponse(response);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): Promise<void> {
    const resolver = new AhkIncludeResolver({
      rootPath: this.config.program,
      runtimePath: this.config.runtime,
      version: this.config.version,
    });

    response.body = {
      sources: resolver.extractAllIncludePath([ 'local', 'user', 'standard' ])
        .map((filePath) => {
          return { name: path.basename(filePath), path: filePath };
        }),
    };
    this.sendResponse(response);
  }
  private async getCurrentBreakpoint(): Promise<dbgp.Breakpoint | null> {
    let stackFrame: dbgp.StackFrame;
    try {
      const { stackFrames } = await this.session.sendStackGetCommand();
      stackFrame = stackFrames[0];
    }
    catch (error) {
      return null;
    }

    const { fileUri, line } = stackFrame;
    const filePath = this.convertDebuggerPathToClient(fileUri);
    const breakpoint = this.breakpoints[`${filePath.toLowerCase()}${line}`];

    if (breakpoint) {
      return breakpoint;
    }
    return null;
  }
  private async checkContinuationStatus(response: dbgp.ContinuationResponse, checkExtraBreakpoint = false): Promise<void> {
    if (response.status === 'stopped') {
      this.sendEvent(new TerminatedEvent('Debug exited'));
    }
    else if (response.status === 'break') {
      if (checkExtraBreakpoint) {
        const breakpoint = await this.getCurrentBreakpoint();
        if (breakpoint) {
          await this.checkAdvancedBreakpoint(breakpoint);
          return;
        }
      }

      const stopReason = response.commandName.startsWith('step')
        ? 'step'
        : 'breakpoint';
      this.sendEvent(new StoppedEvent(stopReason, this.session.id));
    }
  }
  private async checkAdvancedBreakpoint(breakpoint: dbgp.Breakpoint): Promise<void> {
    if (!breakpoint.advancedData) {
      return;
    }
    breakpoint.advancedData.counter++;

    const { condition, hitCondition, logMessage, counter } = breakpoint.advancedData;

    let conditionResult = false, hitConditionResult = false;
    if (condition) {
      conditionResult = await this.conditionalEvaluator.eval(condition);
    }
    if (hitCondition) {
      const match = hitCondition.match(/^(?<operator><=|<|>=|>|==|=|%)?\s*(?<number>\d+)$/u);
      if (match?.groups) {
        const { operator, number } = match.groups;

        let _operator = operator;
        if (typeof _operator === 'undefined') {
          _operator = '>=';
        }
        else if (_operator === '=') {
          _operator = '==';
        }

        const code = _operator === '%'
          ? `(${counter} % ${number} === 0)`
          : `${counter} ${_operator} ${number}`;
        try {
          hitConditionResult = safeEval(code);
        }
        catch {
        }
      }
    }

    let matchCondition = true;
    if (condition && hitCondition) {
      matchCondition = conditionResult && hitConditionResult;
    }
    else if (condition || hitCondition) {
      matchCondition = conditionResult || hitConditionResult;
    }

    if (matchCondition) {
      if (typeof logMessage === 'undefined') {
        this.sendEvent(new StoppedEvent('conditional breakpoint', this.session.id));
        return;
      }

      const log = await this.evalLogMessage(logMessage);
      this.sendEvent(new OutputEvent(log, 'log'));
    }

    const response = await this.session.sendRunCommand();
    await this.checkContinuationStatus(response, true);
  }
  private async evalLogMessage(logMessage: string): Promise<string> {
    let evaled = logMessage;

    const regex = /(?<!\\)\{(?<expression>.+?)(?<!\\)\}/gui;
    await Promise.all(Array.from(logMessage.matchAll(regex), (x) => x[1])
      .map(async(propertyName) => {
        const evaledExpression = await this.session.fetchPrimitiveProperty(propertyName);
        if (evaledExpression) {
          evaled = evaled.replace(new RegExp(regex.source, 'ui'), evaledExpression);
        }
      }));
    return `${evaled}\n`;
  }
}

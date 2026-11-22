using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// One non-inheritable kernel job owns every ordinary CreateProcess descendant.
// JOB_LIST assigns the suspended root at creation, before any user code can run.
public static class MeritHeavyJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr kind, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success, string operation) {
    if (!success) { int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, operation + " failed (" + error + ")."); }
  }
  static uint Active(IntPtr job) {
    Accounting value;
    Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Query job lifetime");
    return value.Active;
  }
  static IntPtr DuplicateStandard(int kind) {
    IntPtr result;
    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out result, 0, true, 2), "Duplicate standard stream");
    return result;
  }
  static string Quoted(string value) {
    if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid native argument.");
    StringBuilder text = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { text.Append('\\', slashes * 2 + 1); text.Append('"'); }
      else { text.Append('\\', slashes); text.Append(character); }
      slashes = 0;
    }
    text.Append('\\', slashes * 2); text.Append('"');
    return text.ToString();
  }

  public static int Run(string file, string[] arguments, StreamReader control, StreamWriter messages) {
    if (String.IsNullOrEmpty(file)) throw new ArgumentException("A native executable is required.");
    IntPtr job = IntPtr.Zero, list = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    bool attributesReady = false;
    bool created = false, contained = false;
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero, "Create job");
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE only: no resource/time caps or breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set owned-job lifetime");
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      list = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list, 2, 0, ref size), "Initialize launch attributes");
      attributesReady = true;
      input = DuplicateStandard(-10); output = DuplicateStandard(-11); error = DuplicateStandard(-12);
      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Restrict inherited handles");
      jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Assign creation-time job containment");
      StartupEx startup = new StartupEx(); startup.Startup.Size = Marshal.SizeOf(typeof(StartupEx));
      startup.Startup.Flags = 0x101; startup.Startup.Show = 0;
      startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error; startup.Attributes = list;
      StringBuilder command = new StringBuilder(Quoted(file));
      foreach (string argument in arguments ?? new string[0]) { command.Append(' '); command.Append(Quoted(argument)); }
      Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x8080004, IntPtr.Zero, null, ref startup, out process), "Create suspended contained process");
      created = true;
      bool belongs;
      Check(IsProcessInJob(process.Process, job, out belongs) && belongs, "Verify job containment");
      contained = true;
      messages.WriteLine("ready"); messages.Flush();
      // Reading control must never block the startup thread or a duplex ready write.
      Task<string> cancellation = Task.Factory.StartNew(() => control.ReadLine(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      uint? cancelled = null;
      if (!cancellation.IsCompleted) Check(ResumeThread(process.Thread) != UInt32.MaxValue, "Resume contained process");
      while (Active(job) != 0) {
        if (cancelled == null && cancellation.IsCompleted) {
          string signal = cancellation.GetAwaiter().GetResult();
          cancelled = signal == "SIGINT" ? 130u : signal == "SIGTERM" ? 143u : 1u;
          Check(TerminateJobObject(job, cancelled.Value), "Cancel owned job");
        }
        Thread.Sleep(20);
      }
      uint exit;
      Check(GetExitCodeProcess(process.Process, out exit), "Read contained process exit");
      return unchecked((int)(cancelled ?? exit));
    } finally {
      if (created && !contained && WaitForSingleObject(process.Process, 0) != 0) {
        Check(TerminateProcess(process.Process, 1), "Clean up uncontained suspended process");
        WaitForSingleObject(process.Process, UInt32.MaxValue);
      }
      // A supervisor crash closes this non-inherited handle in the kernel too.
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (attributesReady) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if (input != IntPtr.Zero) CloseHandle(input);
      if (output != IntPtr.Zero) CloseHandle(output);
      if (error != IntPtr.Zero) CloseHandle(error);
    }
  }
}
